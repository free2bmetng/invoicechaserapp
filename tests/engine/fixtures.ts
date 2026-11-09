// Fixtures for engine tests. Setup and reads go through the superuser (adminQuery),
// which bypasses RLS. The engine itself is always called through its public API.
import { adminQuery, createUser } from "../helpers/db";
import { fixedClock, type Clock } from "@/lib/clock";
import { provisionUser, planInvoice } from "@/lib/engine";
import { FakeEmailProvider, FakePaymentProvider } from "@/lib/providers/fake";
import type { EmailProvider, PaymentProvider } from "@/lib/providers/types";

// Tuesday 2026-11-10, 12:00 UTC. Inside the 09:00-17:00 window for UTC clients.
export const NOW = "2026-11-10T12:00:00.000Z";
// Before any step of a 2026-11-10 invoice is due, so planning keeps them.
export const PLAN_AT = "2026-11-09T12:00:00.000Z";

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function clockAt(iso: string): Clock & { set(iso: string): void } {
  return fixedClock(iso);
}

export interface Owner {
  userId: string;
  email: string;
}

// Onboarding is finished by default, so most tests plan immediately. Pass onboarding: false
// for a user who has not finished setup (spec 3.8).
export async function setupUser(opts: {
  timezone?: string;
  dailyCap?: number;
  profile?: boolean;
  sendingDomain?: string | null;
  onboarding?: boolean;
} = {}): Promise<Owner> {
  const email = `${uniq("owner")}@example.test`;
  const userId = await createUser(email);
  await provisionUser(userId, clockAt(NOW));
  const profile = opts.profile === false ? ["", "", ""] : ["Ada Lovelace", "Ada Studio", "1 Main St, Springfield"];
  const domain = opts.sendingDomain === undefined ? "mail.example.test" : opts.sendingDomain;
  await adminQuery(
    `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5,
       sending_domain = $6, daily_cap = $7, onboarding_done = $8 where user_id = $1`,
    [userId, profile[0], profile[1], profile[2], opts.timezone ?? "UTC", domain, opts.dailyCap ?? 20, opts.onboarding ?? true],
  );
  return { userId, email };
}

export async function addContact(
  userId: string,
  clientId: string,
  email: string,
  primary = false,
  name = "",
): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    `insert into contacts (user_id, client_id, email, name, is_primary) values ($1, $2, $3, $4, $5) returning id`,
    [userId, clientId, email.toLowerCase(), name, primary],
  );
  return rows[0].id;
}

export interface ClientFixture {
  clientId: string;
  contactId: string;
  email: string;
}

export async function addClient(
  userId: string,
  opts: { name?: string; email?: string; timezone?: string | null; autoSend?: boolean; sequenceId?: string | null } = {},
): Promise<ClientFixture> {
  const email = (opts.email ?? `${uniq("client")}@example.test`).toLowerCase();
  const { rows } = await adminQuery<{ id: string }>(
    `insert into clients (user_id, name, email, timezone, auto_send, sequence_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [userId, opts.name ?? "Acme Ltd", email, opts.timezone ?? null, opts.autoSend ?? false, opts.sequenceId ?? null],
  );
  const clientId = rows[0].id;
  const contactId = await addContact(userId, clientId, email, true, "Accounts");
  return { clientId, contactId, email };
}

export async function addInvoice(
  userId: string,
  clientId: string,
  opts: {
    number?: string;
    amountMinor?: number;
    currency?: string;
    issue?: string;
    due?: string;
    status?: string;
    sequenceId?: string | null;
    contactId?: string;
  } = {},
): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status, sequence_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      userId,
      clientId,
      opts.number ?? uniq("INV-"),
      opts.amountMinor ?? 10000,
      opts.currency ?? "USD",
      opts.issue ?? "2026-10-01",
      opts.due ?? "2026-11-10",
      opts.status ?? "open",
      opts.sequenceId ?? null,
    ],
  );
  const invoiceId = rows[0].id;
  let contactId = opts.contactId;
  if (!contactId) {
    const primary = await adminQuery<{ id: string }>(
      "select id from contacts where client_id = $1 and is_primary", [clientId],
    );
    contactId = primary.rows[0].id;
  }
  await adminQuery(
    `insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'primary')`,
    [userId, invoiceId, contactId],
  );
  return invoiceId;
}

export async function addCc(userId: string, invoiceId: string, contactId: string): Promise<void> {
  await adminQuery(
    `insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'cc')`,
    [userId, invoiceId, contactId],
  );
}

export async function addInstallments(
  userId: string,
  invoiceId: string,
  items: { due: string; amountMinor: number }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, item] of items.entries()) {
    const { rows } = await adminQuery<{ id: string }>(
      `insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency)
       select user_id, id, $3::int, $4::date, $5::bigint, currency from invoices where id = $2 and user_id = $1 returning id`,
      [userId, invoiceId, index + 1, item.due, item.amountMinor],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

export async function setAutoSendRaw(clientId: string, value: boolean): Promise<void> {
  await adminQuery("update clients set auto_send = $2 where id = $1", [clientId, value]);
}

export async function invoiceRow(invoiceId: string) {
  const { rows } = await adminQuery<{
    status: string; paid_at: Date | null; stripe_payment_link_id: string | null;
    stripe_payment_link_url: string | null; stripe_link_amount_minor: string | null; stripe_link_currency: string | null;
    amount_minor: string; currency: string; notes: string;
  }>(
    `select status, paid_at, stripe_payment_link_id, stripe_payment_link_url, stripe_link_amount_minor::text,
       stripe_link_currency::text, amount_minor::text, currency, notes from invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

export interface RowView {
  id: string;
  status: string;
  prior_status: string | null;
  planned_at: Date;
  requires_approval: boolean;
  dedupe_key: string;
  step_id: string | null;
  installment_id: string | null;
  contact_id: string;
  subject_override: string | null;
  body_override: string | null;
  claimed_at: Date | null;
}

export async function rowsOf(invoiceId: string): Promise<RowView[]> {
  const { rows } = await adminQuery<RowView>(
    `select id, status, prior_status, planned_at, requires_approval, dedupe_key, step_id, installment_id,
       contact_id, subject_override, body_override, claimed_at
     from scheduled_messages where invoice_id = $1 order by planned_at, dedupe_key`,
    [invoiceId],
  );
  return rows;
}

export async function statusesOf(invoiceId: string): Promise<string[]> {
  return (await rowsOf(invoiceId)).map((r) => r.status);
}

export async function rowStatus(rowId: string): Promise<string> {
  const { rows } = await adminQuery<{ status: string }>("select status from scheduled_messages where id = $1", [rowId]);
  return rows[0].status;
}

export async function logsOf(invoiceId: string) {
  const { rows } = await adminQuery<{
    id: string; scheduled_message_id: string; provider_message_id: string | null; manual: boolean;
    recipient_email: string; cc_emails: string[]; subject: string; body_snapshot: string;
    delivery_status: string; sent_at: Date;
  }>(
    `select id, scheduled_message_id, provider_message_id, manual, recipient_email, cc_emails, subject,
       body_snapshot, delivery_status, sent_at from message_log where invoice_id = $1 order by sent_at`,
    [invoiceId],
  );
  return rows;
}

export async function eventTypes(invoiceId: string, type?: string): Promise<string[]> {
  const { rows } = await adminQuery<{ type: string }>(
    `select type from events where invoice_id = $1 ${type ? "and type = $2" : ""} order by id`,
    type ? [invoiceId, type] : [invoiceId],
  );
  return rows.map((r) => r.type);
}

// Plans the invoice at a fixed time (default: before the due date).
export async function planAt(userId: string, invoiceId: string, iso: string = PLAN_AT): Promise<void> {
  await planInvoice(userId, invoiceId, clockAt(iso));
}

export interface Deps {
  clock: Clock;
  appUrl: string;
  emailFor(userId: string): Promise<EmailProvider>;
  paymentsFor(userId: string): Promise<PaymentProvider | null>;
  sendTimeoutMs?: number;
}

export function depsFor(
  clock: Clock,
  email: FakeEmailProvider = new FakeEmailProvider(),
  payments: FakePaymentProvider | null = null,
): Deps & { email: FakeEmailProvider; payments: FakePaymentProvider | null } {
  return {
    clock,
    appUrl: "http://localhost:3000",
    email,
    payments,
    emailFor: async () => email,
    paymentsFor: async () => payments,
  };
}
