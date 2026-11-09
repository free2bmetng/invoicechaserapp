// Read helpers for the invoice, client and import screens. Reads run through withUser, so
// row-level security applies, and every predicate also filters by user_id. State changes
// never happen here: they go through the engine (src/lib/engine).
import { DateTime } from "luxon";
import { withUser } from "@/lib/db";
import { EngineError, InvalidStateError, NotFoundError, ValidationError } from "@/lib/engine";
import { isSenderProfileComplete } from "@/lib/templates";

export function zoneOrUtc(zone: string | null | undefined): string {
  if (zone && DateTime.utc().setZone(zone).isValid) return zone;
  return "UTC";
}

export interface Workspace {
  zone: string;
  onboardingDone: boolean;
  profileComplete: boolean;
  stripeConnected: boolean;
  sender: { senderName: string; businessName: string; postalAddress: string };
}

// The user's timezone, sender profile state and whether a Stripe account is connected.
// The Stripe key itself is never read here.
export async function loadWorkspace(userId: string): Promise<Workspace> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      timezone: string; sender_name: string; business_name: string; postal_address: string; onboarding_done: boolean;
    }>(
      "select timezone, sender_name, business_name, postal_address, onboarding_done from settings where user_id = $1",
      [userId],
    );
    const r = rows[0];
    const stripe = await c.query("select 1 from connected_accounts where user_id = $1 and provider = 'stripe'", [userId]);
    const sender = {
      senderName: r?.sender_name ?? "",
      businessName: r?.business_name ?? "",
      postalAddress: r?.postal_address ?? "",
    };
    return {
      zone: zoneOrUtc(r?.timezone),
      onboardingDone: r?.onboarding_done ?? false,
      profileComplete: isSenderProfileComplete(sender),
      stripeConnected: (stripe.rowCount ?? 0) > 0,
      sender,
    };
  });
}

export interface ContactChoice {
  id: string;
  name: string;
  email: string;
  isPrimary: boolean;
}

export interface ClientChoice {
  id: string;
  name: string;
  email: string;
  sequenceId: string | null;
  contacts: ContactChoice[];
}

// Every client with its contacts, for pickers. The primary contact is listed first.
export async function listClientChoices(userId: string): Promise<ClientChoice[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      id: string; name: string; email: string; sequence_id: string | null;
      contact_id: string | null; contact_name: string | null; contact_email: string | null; is_primary: boolean | null;
    }>(
      `select cl.id, cl.name, cl.email, cl.sequence_id, ct.id as contact_id, ct.name as contact_name,
         ct.email as contact_email, ct.is_primary
       from clients cl left join contacts ct on ct.client_id = cl.id and ct.user_id = cl.user_id
       where cl.user_id = $1 order by lower(cl.name), cl.id, ct.is_primary desc nulls last, ct.email`,
      [userId],
    );
    const byId = new Map<string, ClientChoice>();
    for (const r of rows) {
      let client = byId.get(r.id);
      if (!client) {
        client = { id: r.id, name: r.name, email: r.email, sequenceId: r.sequence_id, contacts: [] };
        byId.set(r.id, client);
      }
      if (r.contact_id && r.contact_email !== null) {
        client.contacts.push({
          id: r.contact_id,
          name: r.contact_name ?? "",
          email: r.contact_email,
          isPrimary: r.is_primary === true,
        });
      }
    }
    return [...byId.values()];
  });
}

export interface SequenceChoice {
  id: string;
  name: string;
  isDefault: boolean;
}

// Standard sequences, for the sequence pickers.
export async function listStandardSequenceChoices(userId: string): Promise<SequenceChoice[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ id: string; name: string; is_default: boolean }>(
      "select id, name, is_default from sequences where user_id = $1 and kind = 'standard' order by is_default desc, lower(name)",
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, isDefault: r.is_default }));
  });
}

// The currency of the user's most recent invoice, used as the default in the new-invoice form.
export async function lastInvoiceCurrency(userId: string): Promise<string | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ currency: string }>(
      "select currency from invoices where user_id = $1 order by created_at desc limit 1",
      [userId],
    );
    return rows[0]?.currency ?? null;
  });
}

// The CSV duplicate keys of every invoice the user already has: "client_email|invoice_number".
export async function existingInvoiceKeys(userId: string): Promise<Set<string>> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ email: string; invoice_number: string }>(
      "select cl.email, i.invoice_number from invoices i join clients cl on cl.id = i.client_id where i.user_id = $1",
      [userId],
    );
    return new Set(rows.map((r) => `${r.email.toLowerCase()}|${r.invoice_number}`));
  });
}

export interface NextMessageRow {
  status: string;
  plannedAt: string;
  requiresApproval: boolean;
  // Planned times are shown in the client's timezone. Null means the user's timezone applies.
  clientTimezone: string | null;
}

// The next unsent message per invoice (the earliest of pending approval, scheduled or held).
export async function nextMessagesByInvoice(userId: string, invoiceIds: readonly string[]): Promise<Map<string, NextMessageRow>> {
  const out = new Map<string, NextMessageRow>();
  if (invoiceIds.length === 0) return out;
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      invoice_id: string; status: string; planned_at: Date; requires_approval: boolean; client_timezone: string | null;
    }>(
      `select distinct on (m.invoice_id) m.invoice_id, m.status, m.planned_at, m.requires_approval, cl.timezone as client_timezone
       from scheduled_messages m
         join invoices i on i.id = m.invoice_id and i.user_id = m.user_id
         join clients cl on cl.id = i.client_id and cl.user_id = m.user_id
       where m.user_id = $1 and m.invoice_id = any($2::uuid[]) and m.status in ('pending_approval', 'scheduled', 'held')
       order by m.invoice_id, m.planned_at, m.id`,
      [userId, [...invoiceIds]],
    );
    for (const r of rows) {
      out.set(r.invoice_id, {
        status: r.status,
        plannedAt: r.planned_at.toISOString(),
        requiresApproval: r.requires_approval,
        clientTimezone: r.client_timezone,
      });
    }
    return out;
  });
}

// The earliest open installment date per payment-plan invoice. Overdue checks use it.
export async function openInstallmentDues(userId: string, invoiceIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (invoiceIds.length === 0) return out;
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ invoice_id: string; due: string }>(
      `select invoice_id, min(due_date)::text as due from payment_plan_installments
       where user_id = $1 and invoice_id = any($2::uuid[]) and status = 'open' group by invoice_id`,
      [userId, [...invoiceIds]],
    );
    for (const r of rows) out.set(r.invoice_id, r.due);
    return out;
  });
}

// Turns an engine error into a sentence for the user. Unknown errors are logged by name only.
export function describeEngineError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof ValidationError) return err.errors.join(" ");
  if (err instanceof InvalidStateError || err instanceof EngineError) return err.message;
  console.error("Invoice action failed:", err instanceof Error ? err.name : "unknown error");
  return "Something went wrong. Try again in a moment.";
}

// How many reminders for this client are on hold (the reply hold, or a contact hold).
export async function heldMessageCountForClient(userId: string, clientId: string): Promise<number> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `select count(*)::text as n from scheduled_messages m
         join invoices i on i.id = m.invoice_id and i.user_id = m.user_id
       where m.user_id = $1 and i.client_id = $2 and m.status = 'held'`,
      [userId, clientId],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

// Overdue money per currency across every outstanding payable. Plans count their open installments.
export async function overdueByCurrency(userId: string, today: string): Promise<{ currency: string; amountMinor: number }[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ currency: string; total: string }>(
      `select currency, sum(amount)::text as total from (
         select i.currency, i.amount_minor as amount from invoices i
          where i.user_id = $1 and i.status in ('open', 'paused', 'disputed') and i.due_date < $2
         union all
         select p.currency, p.amount_minor from payment_plan_installments p
           join invoices i on i.id = p.invoice_id and i.user_id = p.user_id
          where p.user_id = $1 and i.status = 'payment_plan' and p.status = 'open' and p.due_date < $2
       ) overdue group by currency order by currency`,
      [userId, today],
    );
    return rows.map((r) => ({ currency: r.currency, amountMinor: Number(r.total) }));
  });
}

// Reminders waiting for the user's approval. The Needs you queue shows the same items.
export async function pendingApprovalCount(userId: string): Promise<number> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "select count(*)::text as n from scheduled_messages where user_id = $1 and status = 'pending_approval'",
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export interface ClientInvoiceDefaults {
  currency: string;
  // Days from issue to due date on the client's most recent invoice.
  termsDays: number;
}

// Per client, the currency and payment terms of their most recent invoice. The new-invoice form
// defaults to these when a client is chosen, so a client billed in GBP gets GBP.
export async function clientInvoiceDefaults(userId: string): Promise<Record<string, ClientInvoiceDefaults>> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ client_id: string; currency: string; terms: number }>(
      `select distinct on (client_id) client_id, currency, (due_date - issue_date)::int as terms
       from invoices where user_id = $1 order by client_id, created_at desc, id`,
      [userId],
    );
    const out: Record<string, ClientInvoiceDefaults> = {};
    for (const r of rows) out[r.client_id] = { currency: r.currency, termsDays: Math.max(0, Number(r.terms)) };
    return out;
  });
}

export interface ReceivablesSummary {
  currency: string;
  outstandingMinor: number;
  outstandingCount: number;
  overdueMinor: number;
  overdueCount: number;
  oldestOverdueDays: number;
  dueSoonMinor: number;
  dueSoonCount: number;
  // Ageing of the outstanding money: not yet due, 1–30, 31–90 and over 90 days overdue.
  buckets: { notDue: number; upTo30: number; upTo90: number; older: number };
}

// Outstanding money per currency, as payables: an invoice that is open, paused or disputed, or
// each open installment of a payment plan. Ordered by how many invoices each currency has.
export async function receivablesSummary(userId: string, today: string): Promise<ReceivablesSummary[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<Record<string, string>>(
      `with payables as (
         select i.id as invoice_id, i.currency, i.amount_minor as amount, i.due_date from invoices i
          where i.user_id = $1 and i.status in ('open', 'paused', 'disputed')
         union all
         select p.invoice_id, p.currency, p.amount_minor, p.due_date from payment_plan_installments p
           join invoices i on i.id = p.invoice_id and i.user_id = p.user_id
          where p.user_id = $1 and i.status = 'payment_plan' and p.status = 'open'
       )
       select currency,
         sum(amount)::text as outstanding,
         count(distinct invoice_id)::text as outstanding_count,
         coalesce(sum(amount) filter (where due_date < $2::date), 0)::text as overdue,
         (count(distinct invoice_id) filter (where due_date < $2::date))::text as overdue_count,
         coalesce(max($2::date - due_date) filter (where due_date < $2::date), 0)::text as oldest,
         coalesce(sum(amount) filter (where due_date >= $2::date and due_date < $2::date + 7), 0)::text as due_soon,
         (count(distinct invoice_id) filter (where due_date >= $2::date and due_date < $2::date + 7))::text as due_soon_count,
         coalesce(sum(amount) filter (where due_date >= $2::date), 0)::text as b_not_due,
         coalesce(sum(amount) filter (where due_date < $2::date and $2::date - due_date <= 30), 0)::text as b_30,
         coalesce(sum(amount) filter (where $2::date - due_date between 31 and 90), 0)::text as b_90,
         coalesce(sum(amount) filter (where $2::date - due_date > 90), 0)::text as b_older
       from payables group by currency order by count(distinct invoice_id) desc, currency`,
      [userId, today],
    );
    return rows.map((r) => ({
      currency: r.currency,
      outstandingMinor: Number(r.outstanding),
      outstandingCount: Number(r.outstanding_count),
      overdueMinor: Number(r.overdue),
      overdueCount: Number(r.overdue_count),
      oldestOverdueDays: Number(r.oldest),
      dueSoonMinor: Number(r.due_soon),
      dueSoonCount: Number(r.due_soon_count),
      buckets: { notDue: Number(r.b_not_due), upTo30: Number(r.b_30), upTo90: Number(r.b_90), older: Number(r.b_older) },
    }));
  });
}

export interface PlanProgress {
  paidMinor: number;
  openMinor: number;
  // The earliest open installment date, or null when every installment is paid.
  nextDue: string | null;
  paidCount: number;
  count: number;
}

// Payment-plan progress per invoice: what is paid, what is left, and the next date.
export async function planProgressByInvoice(userId: string, invoiceIds: readonly string[]): Promise<Map<string, PlanProgress>> {
  const out = new Map<string, PlanProgress>();
  if (invoiceIds.length === 0) return out;
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ invoice_id: string; paid: string; open: string; next_due: string | null; paid_count: string; n: string }>(
      `select invoice_id,
         coalesce(sum(amount_minor) filter (where status = 'paid'), 0)::text as paid,
         coalesce(sum(amount_minor) filter (where status = 'open'), 0)::text as open,
         (min(due_date) filter (where status = 'open'))::text as next_due,
         (count(*) filter (where status = 'paid'))::text as paid_count,
         count(*)::text as n
       from payment_plan_installments where user_id = $1 and invoice_id = any($2::uuid[]) group by invoice_id`,
      [userId, [...invoiceIds]],
    );
    for (const r of rows) {
      out.set(r.invoice_id, {
        paidMinor: Number(r.paid),
        openMinor: Number(r.open),
        nextDue: r.next_due,
        paidCount: Number(r.paid_count),
        count: Number(r.n),
      });
    }
    return out;
  });
}

// The invoice number and client name, for the browser tab title. Null when not found.
export async function invoiceTitle(userId: string, invoiceId: string): Promise<{ number: string; client: string } | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ invoice_number: string; name: string }>(
      `select i.invoice_number, cl.name from invoices i join clients cl on cl.id = i.client_id and cl.user_id = i.user_id
       where i.id = $1 and i.user_id = $2`,
      [invoiceId, userId],
    );
    return rows[0] ? { number: rows[0].invoice_number, client: rows[0].name } : null;
  });
}
