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
