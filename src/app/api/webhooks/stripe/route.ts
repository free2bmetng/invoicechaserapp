// Platform webhook for Stripe Connect OAuth accounts. One endpoint serves every connected
// account. Events carry event.account, which is the connected account id. That id is stored in
// connected_accounts.account_label, and it identifies the user. The signature is checked with
// STRIPE_CONNECT_WEBHOOK_SECRET. Events from accounts that are not connected are acknowledged
// and ignored, so Stripe stops retrying them.
import Stripe from "stripe";
import { withService } from "@/lib/db";
import { handleStripeEvent } from "@/lib/providers/stripe-events";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) return new Response("Connect webhook secret is not configured", { status: 500 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe-Signature header", { status: 400 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(raw, signature, secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (!event.account) return Response.json({ received: true, ignored: "not a connected-account event" });
  const userId = await userForAccount(event.account);
  if (!userId) return Response.json({ received: true, ignored: "unknown account" });

  const { duplicate } = await handleStripeEvent(event, userId);
  return Response.json(duplicate ? { received: true, duplicate: true } : { received: true });
}

async function userForAccount(accountId: string): Promise<string | null> {
  const { rows } = await withService((c) =>
    c.query<{ user_id: string }>(
      "select user_id from connected_accounts where provider = 'stripe' and account_label = $1",
      [accountId],
    ),
  );
  return rows[0]?.user_id ?? null;
}
