// Stripe payment links, one per payable. A link is reused only while both its amount
// and its currency match the payable. Otherwise a new link is created and the old one
// is deactivated. Links created before migration 0003 have no currency and are replaced once.
import type { PoolClient } from "pg";
import type { PaymentProvider } from "@/lib/providers/types";
import type * as S from "./store";
import { logEvent } from "./store";

// The stored link, when it still matches the payable's amount and currency. Null otherwise.
// Reads and the sender use this same test.
export function reusableLinkUrl(target: {
  amount_minor: number;
  currency: string;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  stripe_link_amount_minor: number | null;
  stripe_link_currency: string | null;
}): string | null {
  const reusable =
    target.stripe_payment_link_id !== null &&
    target.stripe_payment_link_url !== null &&
    target.stripe_link_amount_minor === target.amount_minor &&
    target.stripe_link_currency === target.currency;
  return reusable ? (target.stripe_payment_link_url as string) : null;
}

export async function ensurePaymentLink(
  c: PoolClient,
  userId: string,
  payments: PaymentProvider,
  payable: { invoice: S.InvoiceRow; installment: S.InstallmentRow | null },
  at: Date,
): Promise<string> {
  const { invoice, installment } = payable;
  const target = installment ?? invoice;
  const payableId = installment ? installment.id : invoice.id;
  const storedId = target.stripe_payment_link_id;
  const reusable = reusableLinkUrl(target);
  if (reusable) return reusable;

  const created = await payments.createPaymentLink({
    amountMinor: target.amount_minor,
    currency: target.currency,
    metadata: { payable_id: payableId, invoice_id: invoice.id, user_id: userId },
  });

  if (installment) {
    await c.query(
      `update payment_plan_installments set stripe_payment_link_id = $3, stripe_payment_link_url = $4,
         stripe_link_amount_minor = $5, stripe_link_currency = $6 where id = $1 and user_id = $2`,
      [installment.id, userId, created.id, created.url, target.amount_minor, target.currency],
    );
  } else {
    await c.query(
      `update invoices set stripe_payment_link_id = $3, stripe_payment_link_url = $4,
         stripe_link_amount_minor = $5, stripe_link_currency = $6, updated_at = $7
       where id = $1 and user_id = $2`,
      [invoice.id, userId, created.id, created.url, target.amount_minor, target.currency, at],
    );
  }

  if (storedId && storedId !== created.id) {
    try {
      await payments.deactivatePaymentLink(storedId);
    } catch {
      // The new link is what the message carries. The failure is recorded, not hidden.
      await logEvent(c, {
        userId,
        invoiceId: invoice.id,
        type: "payment_link_deactivate_failed",
        detail: { payable_id: payableId },
        at,
      });
    }
  }
  await logEvent(c, {
    userId,
    invoiceId: invoice.id,
    type: "payment_link_created",
    detail: { payable_id: payableId, amount_minor: target.amount_minor, currency: target.currency },
    at,
  });
  return created.url;
}
