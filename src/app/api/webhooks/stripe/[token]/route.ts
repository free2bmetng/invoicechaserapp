// Restricted-key webhook for one connection (internal testing only). Each restricted connection
// has its own endpoint, URL and signing secret (see stripe-connection.ts). The token in the path
// selects the connection, and its signing secret is decrypted from the database. Refused unless
// STRIPE_KEY_MODE=restricted. OAuth connections use the platform endpoint at /api/webhooks/stripe.
import Stripe from "stripe";
import { decryptSecret } from "@/lib/crypto";
import { withService } from "@/lib/db";
import { handleStripeEvent } from "@/lib/providers/stripe-events";
import { restrictedKeyMode } from "@/lib/providers/stripe-platform";

const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type RouteContext = { params: Promise<{ token: string }> };

type Connection = { userId: string; webhookSecretCiphertext: string };

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  if (!restrictedKeyMode()) return notFound();
  const { token } = await params;
  if (!TOKEN_PATTERN.test(token)) return notFound();
  const connection = await findConnection(token);
  if (!connection) return notFound();

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe-Signature header", { status: 400 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  // A decryption failure is a server fault (for example a rotated key), so it is a 500.
  const signingSecret = decryptSecret(connection.webhookSecretCiphertext);

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(raw, signature, signingSecret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  const { duplicate } = await handleStripeEvent(event, connection.userId);
  return Response.json(duplicate ? { received: true, duplicate: true } : { received: true });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function findConnection(token: string): Promise<Connection | null> {
  const { rows } = await withService((c) =>
    c.query<{ user_id: string; webhook_secret_ciphertext: string }>(
      `select user_id, webhook_secret_ciphertext from connected_accounts
        where webhook_token = $1 and provider = 'stripe' and webhook_secret_ciphertext is not null`,
      [token],
    ),
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, webhookSecretCiphertext: rows[0].webhook_secret_ciphertext };
}
