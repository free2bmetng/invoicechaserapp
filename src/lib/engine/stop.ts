// Status changes and payments (spec 3.4). Stop statuses cancel every unsent row
// in the same transaction as the status commit. Resume replans and restores the
// cancelled rows that are still in the future, and never bursts missed steps.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import type { InvoiceStatus } from "@/lib/types";
import { ValidationError, InvalidStateError, NotFoundError } from "./errors";
import { planInvoiceTx } from "./plan";
import * as S from "./store";
import { validateInstallments, type InstallmentInput } from "./installments";

const STOP_LIKE: InvoiceStatus[] = ["paid", "paused", "disputed", "written_off"];

export async function applyInvoiceStatus(
  c: PoolClient,
  userId: string,
  invoiceId: string,
  status: InvoiceStatus,
  at: Date,
  paidAt: Date | null,
): Promise<void> {
  const invoice = await S.loadInvoice(c, userId, invoiceId);
  if (status === "payment_plan") {
    const count = (await S.installmentsOf(c, userId, invoiceId)).length;
    if (count < 1) throw new ValidationError("A payment plan needs at least one installment before it can start.");
  }

  if (invoice.status !== status) {
    const paidValue = status === "paid" ? paidAt ?? at : null;
    await c.query(
      "update invoices set status = $3, paid_at = $4, updated_at = $5 where id = $1 and user_id = $2",
      [invoiceId, userId, status, paidValue, at],
    );
    await S.logEvent(c, {
      userId,
      invoiceId,
      clientId: invoice.client_id,
      type: "status_changed",
      detail: { from: invoice.status, to: status },
      at,
    });
  }

  if (status === "paid") {
    for (const inst of await S.installmentsOf(c, userId, invoiceId)) {
      if (inst.status !== "open") continue;
      await c.query(
        "update payment_plan_installments set status = 'paid', paid_at = $3 where id = $1 and user_id = $2",
        [inst.id, userId, paidAt ?? at],
      );
      await S.logEvent(c, { userId, invoiceId, type: "payable_paid", detail: { installment_id: inst.id }, at });
    }
  }

  if (STOP_LIKE.includes(status)) {
    await S.cancelUnsentWhere(c, userId, { invoiceId }, at, status);
    return;
  }
  await planInvoiceTx(c, userId, invoiceId, at);
  await S.restoreCancelledForInvoice(c, userId, invoiceId, at);
}

export async function setInvoiceStatus(userId: string, invoiceId: string, status: InvoiceStatus, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    await applyInvoiceStatus(c, userId, invoiceId, status, clock.now(), null);
  });
}

export interface RecordPaymentArgs {
  userId: string;
  invoiceId: string;
  installmentId: string | null;
  paidAt: Date;
  source: "stripe" | "manual";
  clock: Clock;
}

// A payment that marks a disputed or written-off invoice paid is logged, so the account
// holder can check the dispute. The Needs you item stays until acknowledged.
async function notePaidWhileDisputed(c: PoolClient, userId: string, invoice: S.InvoiceRow, source: string, paidAt: Date, at: Date): Promise<void> {
  if (invoice.status !== "disputed" && invoice.status !== "written_off") return;
  await S.logEvent(c, {
    userId,
    invoiceId: invoice.id,
    clientId: invoice.client_id,
    type: "paid_while_disputed",
    detail: { prior_status: invoice.status, source, paid_at: paidAt.toISOString() },
    at,
  });
}

// Idempotent. A second call for the same payable changes nothing.
export async function recordPayment(args: RecordPaymentArgs): Promise<void> {
  const { userId, invoiceId, installmentId, paidAt, source, clock } = args;
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const invoice = await S.loadInvoice(c, userId, invoiceId);

    if (installmentId) {
      const inst = await S.loadInstallment(c, userId, installmentId);
      if (!inst || inst.invoice_id !== invoiceId) throw new NotFoundError("Installment");
      if (inst.status === "paid") return;
      await c.query(
        "update payment_plan_installments set status = 'paid', paid_at = $3 where id = $1 and user_id = $2",
        [installmentId, userId, paidAt],
      );
      await S.logEvent(c, {
        userId,
        invoiceId,
        clientId: invoice.client_id,
        type: "payment_recorded",
        detail: { installment_id: installmentId, source },
        at,
      });
      await S.cancelUnsentWhere(c, userId, { installmentId }, at, "installment_paid");
      const remaining = await c.query<{ open: string }>(
        "select count(*)::text as open from payment_plan_installments where invoice_id = $1 and user_id = $2 and status = 'open'",
        [invoiceId, userId],
      );
      if (Number(remaining.rows[0].open) === 0 && invoice.status !== "paid") {
        await notePaidWhileDisputed(c, userId, invoice, source, paidAt, at);
        await applyInvoiceStatus(c, userId, invoiceId, "paid", at, paidAt);
      }
      return;
    }

    if (invoice.status === "paid") return;
    await S.logEvent(c, {
      userId,
      invoiceId,
      clientId: invoice.client_id,
      type: "payment_recorded",
      detail: { source },
      at,
    });
    await notePaidWhileDisputed(c, userId, invoice, source, paidAt, at);
    // Spec default: a payment marks the invoice paid even if it was disputed or written off.
    await applyInvoiceStatus(c, userId, invoiceId, "paid", at, paidAt);
  });
}

export interface PlanInstallmentInput {
  dueDate: string;
  amountMinor: number;
}

// Sets or replaces a payment plan. Refused when an installment has been paid or
// has sent messages, because those rows and their history cannot be removed.
export async function setPaymentPlan(
  userId: string,
  invoiceId: string,
  installments: PlanInstallmentInput[],
  clock: Clock,
): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const invoice = await S.loadInvoice(c, userId, invoiceId);
    if (invoice.status !== "open" && invoice.status !== "payment_plan") {
      throw new InvalidStateError("Only open invoices can take a payment plan.");
    }
    const inputs: InstallmentInput[] = installments.map((i) => ({ dueDate: i.dueDate, amountMinor: i.amountMinor }));
    const check = validateInstallments(invoice.amount_minor, inputs);
    if (!check.ok) throw new ValidationError(check.errors);

    const existing = await S.installmentsOf(c, userId, invoiceId);
    if (existing.some((i) => i.status === "paid")) {
      throw new InvalidStateError("A payment plan with a paid installment cannot be replaced.");
    }
    const ids = existing.map((i) => i.id);
    if (ids.length > 0) {
      const busy = await c.query<{ n: string }>(
        `select count(*)::text as n from scheduled_messages
         where installment_id = any($1::uuid[]) and user_id = $2 and status in ('sending', 'sent', 'delivered', 'bounced', 'needs_check')`,
        [ids, userId],
      );
      if (Number(busy.rows[0].n) > 0) {
        throw new InvalidStateError("This payment plan has sent or in-flight messages and cannot be replaced.");
      }
      await c.query("delete from scheduled_messages where installment_id = any($1::uuid[]) and user_id = $2", [ids, userId]);
      await c.query("delete from payment_plan_installments where id = any($1::uuid[]) and user_id = $2", [ids, userId]);
    }

    for (const [index, inst] of installments.entries()) {
      await c.query(
        `insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency, status)
         values ($1, $2, $3, $4, $5, $6, 'open')`,
        [userId, invoiceId, index + 1, inst.dueDate, inst.amountMinor, invoice.currency],
      );
    }
    await S.logEvent(c, {
      userId,
      invoiceId,
      clientId: invoice.client_id,
      type: "payment_plan_set",
      detail: { installments: installments.length },
      at,
    });
    await applyInvoiceStatus(c, userId, invoiceId, "payment_plan", at, null);
  });
}

// The account holder has checked the dispute. Clears the paid-while-disputed item.
// Returns false, and logs nothing, when no item is open.
export async function acknowledgePaidWhileDisputed(
  userId: string,
  invoiceId: string,
  clock: Clock,
): Promise<{ acknowledged: boolean }> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const invoice = await S.loadInvoice(c, userId, invoiceId);
    const latest = await c.query<{ id: string }>(
      `select id from events where user_id = $1 and invoice_id = $2 and type = 'paid_while_disputed'
       order by id desc limit 1`,
      [userId, invoiceId],
    );
    const flagId = latest.rows[0]?.id;
    if (!flagId) return { acknowledged: false };
    const acked = await c.query(
      `select 1 from events where user_id = $1 and invoice_id = $2
         and type = 'paid_while_disputed_acknowledged' and id > $3 limit 1`,
      [userId, invoiceId, flagId],
    );
    if (acked.rows.length > 0) return { acknowledged: false };
    await S.logEvent(c, {
      userId,
      invoiceId,
      clientId: invoice.client_id,
      type: "paid_while_disputed_acknowledged",
      detail: {},
      at,
    });
    return { acknowledged: true };
  });
}
