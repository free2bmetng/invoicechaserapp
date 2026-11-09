// Delivery-status webhook from the email provider. The provider signs the raw body:
// header x-webhook-signature = hex HMAC-SHA256(rawBody, PROVIDER_WEBHOOK_SECRET).
// Unknown but valid events get a 200 so the provider stops retrying them. Engine
// calls must be idempotent, because the provider may deliver the same event twice.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { systemClock } from "@/lib/clock";
import { recordBounce, recordDeliveryStatus } from "@/lib/engine";

const MAX_BODY_BYTES = 64 * 1024;

const eventSchema = z.object({
  type: z.string().min(1).max(64),
  provider: z.enum(["resend"]),
  provider_message_id: z.string().min(1).max(256),
});

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.PROVIDER_WEBHOOK_SECRET;
  // With no secret, an empty-key HMAC would be forgeable. Refuse to run instead.
  if (!secret) return new Response("Webhook secret is not configured", { status: 500 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  const provided = (request.headers.get("x-webhook-signature") ?? "").trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  if (!signatureMatches(provided, expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return new Response("Body is not JSON", { status: 400 });
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return new Response("Unrecognised event shape", { status: 400 });
  const { type, provider, provider_message_id: providerMessageId } = parsed.data;

  if (type === "delivered" || type === "failed") {
    await recordDeliveryStatus({
      provider,
      providerMessageId,
      status: type,
      clock: systemClock,
    });
  } else if (type === "bounced") {
    await recordBounce({ provider, providerMessageId, clock: systemClock });
  }
  // Any other type is valid but not used in v1: acknowledge it.

  return Response.json({ received: true });
}

function signatureMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Lengths are not secret (the HMAC is always 64 hex characters), and timingSafeEqual
  // throws on unequal lengths, so compare lengths first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
