// Stripe event handling shared by both webhook routes. The route verifies the signature and
// finds the connected user. This module dedupes by event id and applies paid checkout sessions.
//
// Order of work: check stripe_events for this event id and skip if it is there. Otherwise
// process the event, then record its id with on conflict do nothing. A crash between the two
// steps leaves the event unrecorded, so Stripe's retry processes it again. recordPayment is
// idempotent, so the retry is safe and a payment is never lost.
import type Stripe from "stripe";
import { z } from "zod";
import { systemClock } from "@/lib/clock";
import { withService } from "@/lib/db";
import { recordPayment } from "@/lib/engine";

type PayableMetadata = {
  invoiceId: string;
  userId: string;
  // Set when the paid payable is a payment-plan installment.
  payableCandidate: string | undefined;
};

// `userId` is the connected user the event belongs to: the restricted endpoint's owner, or the
// user who owns the event's connected account. Metadata naming any other user is refused.
export async function handleStripeEvent(event: Stripe.Event, userId: string): Promise<{ duplicate: boolean }> {
  if (await isRecorded(event.id)) return { duplicate: true };
  // A thrown error here returns a 500, so Stripe retries the event and the failure is visible.
  await applyEvent(event, userId);
  await recordEvent(event.id, userId);
  return { duplicate: false };
}

async function applyEvent(event: Stripe.Event, connectionUserId: string): Promise<void> {
  if (event.type !== "checkout.session.completed") return;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return;

  const meta = readPayableMetadata(session.metadata);
  if (!meta) return; // not an invoice payment
  // An endpoint belongs to one account, so it may only settle that account's invoices.
  if (meta.userId !== connectionUserId) {
    throw new Error("Stripe session metadata names a different account than this endpoint");
  }

  const installmentId = await resolveInstallment(meta);
  await recordPayment({
    userId: connectionUserId,
    invoiceId: meta.invoiceId,
    installmentId,
    paidAt: new Date(event.created * 1000),
    source: "stripe",
    clock: systemClock,
  });
}

// Returns null for a session that is not ours. Throws for metadata that is ours but
// malformed, so the failure surfaces instead of a real payment being dropped.
function readPayableMetadata(metadata: Stripe.Metadata | null | undefined): PayableMetadata | null {
  const invoiceId = metadata?.invoice_id;
  const userId = metadata?.user_id;
  if (!invoiceId && !userId) return null;
  if (!isUuid(invoiceId) || !isUuid(userId)) {
    throw new Error("Stripe session metadata has a malformed invoice_id or user_id");
  }
  const installmentId = metadata?.installment_id;
  const payableId = metadata?.payable_id;
  const payableCandidate =
    installmentId ?? (payableId && payableId !== invoiceId ? payableId : undefined);
  return { invoiceId, userId, payableCandidate };
}

async function resolveInstallment(meta: PayableMetadata): Promise<string | null> {
  if (!meta.payableCandidate) return null;
  if (!isUuid(meta.payableCandidate)) throw new Error("Stripe payable id is malformed");
  const { rows } = await withService((c) =>
    c.query<{ id: string }>(
      "select id from payment_plan_installments where id = $1 and invoice_id = $2 and user_id = $3",
      [meta.payableCandidate, meta.invoiceId, meta.userId],
    ),
  );
  if (rows.length === 0) throw new Error("Stripe payable does not belong to the invoice");
  return meta.payableCandidate;
}

async function isRecorded(eventId: string): Promise<boolean> {
  const { rowCount } = await withService((c) =>
    c.query("select 1 from stripe_events where event_id = $1", [eventId]),
  );
  return (rowCount ?? 0) > 0;
}

async function recordEvent(eventId: string, userId: string): Promise<void> {
  await withService((c) =>
    c.query(
      "insert into stripe_events (event_id, user_id) values ($1, $2) on conflict (event_id) do nothing",
      [eventId, userId],
    ),
  );
}

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && z.uuid().safeParse(value).success;
}
