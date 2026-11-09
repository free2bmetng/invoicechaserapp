// Shared database helpers for the engine. Every write path takes the per-user
// advisory lock first, so planning, stop conditions, holds, approvals and the
// sender's per-row work are serialized for one user. Queries filter by user_id
// explicitly, because the sender and webhooks run as the service role.
import type { PoolClient } from "pg";
import type { InvoiceStatus, MessageStatus } from "@/lib/types";
import { NotFoundError } from "./errors";

export type Db = PoolClient;
export type Base = "pending_approval" | "scheduled";

export const UNSENT: MessageStatus[] = ["pending_approval", "scheduled", "held"];
export const DISPATCHED: MessageStatus[] = ["sent", "delivered", "bounced", "needs_check"];
export const STOP_STATUSES: InvoiceStatus[] = ["paid", "paused", "disputed", "written_off"];

export interface SettingsRow {
  user_id: string;
  sender_name: string;
  business_name: string;
  postal_address: string;
  timezone: string;
  send_window_start: number;
  send_window_end: number;
  daily_cap: number;
  sending_domain: string | null;
  sending_provider: string;
  onboarding_done: boolean;
}

export interface ClientRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  timezone: string | null;
  sequence_id: string | null;
  auto_send: boolean;
  reply_held_at: Date | null;
}

export interface ContactRow {
  id: string;
  user_id: string;
  client_id: string;
  email: string;
  name: string;
  is_primary: boolean;
  hold: string | null;
}

export interface InvoiceRow {
  id: string;
  user_id: string;
  client_id: string;
  invoice_number: string;
  amount_minor: number;
  currency: string;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  paid_at: Date | null;
  sequence_id: string | null;
  notes: string;
  source: string;
  external_id: string | null;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  stripe_link_amount_minor: number | null;
  stripe_link_currency: string | null;
}

export interface InstallmentRow {
  id: string;
  user_id: string;
  invoice_id: string;
  position: number;
  due_date: string;
  amount_minor: number;
  currency: string;
  status: "open" | "paid";
  paid_at: Date | null;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  stripe_link_amount_minor: number | null;
  stripe_link_currency: string | null;
}

export interface StepRow {
  id: string;
  user_id: string;
  sequence_id: string;
  position: number;
  offset_days: number;
  tone: string;
  subject: string;
  body: string;
  requires_approval: boolean;
  is_final_notice: boolean;
}

export interface SequenceRow {
  id: string;
  user_id: string;
  kind: "standard" | "plan";
  is_default: boolean;
}

export interface MessageRow {
  id: string;
  user_id: string;
  invoice_id: string;
  installment_id: string | null;
  step_id: string | null;
  contact_id: string;
  planned_at: Date;
  status: MessageStatus;
  prior_status: string | null;
  requires_approval: boolean;
  subject_override: string | null;
  body_override: string | null;
  claimed_at: Date | null;
  dedupe_key: string;
}

// ---- Hold state encoding ---------------------------------------------------
// held rows keep the status they return to in prior_status. A row the user held
// is prefixed, so a reason-based release (bounce, reply) never undoes a manual hold.
const USER_HOLD = "user_hold:";

export interface Prior {
  base: Base;
  userHold: boolean;
}

export function encodePrior(prior: Prior): string {
  return (prior.userHold ? USER_HOLD : "") + prior.base;
}

export function decodePrior(raw: string | null | undefined): Prior {
  const text = raw ?? "";
  const userHold = text.startsWith(USER_HOLD);
  const rest = userHold ? text.slice(USER_HOLD.length) : text;
  return { base: rest === "scheduled" ? "scheduled" : "pending_approval", userHold };
}

// Where an unsent row belongs when no hold applies. Approval (rule a) or rule (b)
// keeps it pending. A row that was already scheduled stays scheduled.
export function unsentBase(prior: Prior, requiresApproval: boolean, ruleB: boolean): Base {
  if (prior.base === "scheduled") return "scheduled";
  return requiresApproval || ruleB ? "pending_approval" : "scheduled";
}

export function resolveUnsent(
  prior: Prior,
  requiresApproval: boolean,
  ruleB: boolean,
  holdOn: boolean,
): { status: "pending_approval" | "scheduled" | "held"; prior: string | null } {
  const base = unsentBase(prior, requiresApproval, ruleB);
  if (prior.userHold || holdOn) return { status: "held", prior: encodePrior({ base, userHold: prior.userHold }) };
  return { status: base, prior: null };
}

// ---- Locks, events and conversions ----------------------------------------

export async function lockUser(c: Db, userId: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`invoice-chaser:user:${userId}`]);
}

export interface EventInput {
  userId: string;
  invoiceId?: string | null;
  clientId?: string | null;
  type: string;
  detail?: Record<string, unknown>;
  at: Date;
}

// Events never carry secrets. Callers pass ids, statuses and reasons only.
export async function logEvent(c: Db, e: EventInput): Promise<void> {
  await c.query(
    `insert into events (user_id, invoice_id, client_id, type, detail, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [e.userId, e.invoiceId ?? null, e.clientId ?? null, e.type, JSON.stringify(e.detail ?? {}), e.at],
  );
}

const INVOICE_SELECT = `select id, user_id, client_id, invoice_number, amount_minor::text as amount_minor,
  currency, issue_date::text as issue_date, due_date::text as due_date, status, paid_at, sequence_id,
  notes, source, external_id, stripe_payment_link_id, stripe_payment_link_url, stripe_link_amount_minor::text as stripe_link_amount_minor,
  stripe_link_currency::text as stripe_link_currency
  from invoices`;

const INSTALLMENT_SELECT = `select id, user_id, invoice_id, position, due_date::text as due_date,
  amount_minor::text as amount_minor, currency, status, paid_at, stripe_payment_link_id,
  stripe_payment_link_url, stripe_link_amount_minor::text as stripe_link_amount_minor,
  stripe_link_currency::text as stripe_link_currency
  from payment_plan_installments`;

export const MESSAGE_SELECT = `select id, user_id, invoice_id, installment_id, step_id, contact_id, planned_at,
  status, prior_status, requires_approval, subject_override, body_override, claimed_at, dedupe_key
  from scheduled_messages`;

const STEP_SELECT = `select id, user_id, sequence_id, position, offset_days, tone, subject, body,
  requires_approval, is_final_notice from sequence_steps`;

const CONTACT_SELECT = `select id, user_id, client_id, email, name, is_primary, hold from contacts`;

function mapInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    ...(r as unknown as InvoiceRow),
    amount_minor: Number(r.amount_minor),
    stripe_link_amount_minor: r.stripe_link_amount_minor === null ? null : Number(r.stripe_link_amount_minor),
  };
}

function mapInstallment(r: Record<string, unknown>): InstallmentRow {
  return {
    ...(r as unknown as InstallmentRow),
    amount_minor: Number(r.amount_minor),
    stripe_link_amount_minor: r.stripe_link_amount_minor === null ? null : Number(r.stripe_link_amount_minor),
  };
}

// ---- Loaders ---------------------------------------------------------------

export async function loadSettings(c: Db, userId: string): Promise<SettingsRow> {
  const { rows } = await c.query<SettingsRow>(
    `select user_id, sender_name, business_name, postal_address, timezone, send_window_start,
       send_window_end, daily_cap, sending_domain, sending_provider, onboarding_done from settings where user_id = $1`,
    [userId],
  );
  if (!rows[0]) throw new NotFoundError("Settings");
  return rows[0];
}

export async function loadClient(c: Db, userId: string, clientId: string): Promise<ClientRow> {
  const { rows } = await c.query<ClientRow>(
    `select id, user_id, name, email, timezone, sequence_id, auto_send, reply_held_at
     from clients where id = $1 and user_id = $2`,
    [clientId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Client");
  return rows[0];
}

export async function loadInvoice(c: Db, userId: string, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await c.query(`${INVOICE_SELECT} where id = $1 and user_id = $2`, [invoiceId, userId]);
  if (!rows[0]) throw new NotFoundError("Invoice");
  return mapInvoice(rows[0]);
}

export async function loadInstallment(c: Db, userId: string, installmentId: string): Promise<InstallmentRow | null> {
  const { rows } = await c.query(`${INSTALLMENT_SELECT} where id = $1 and user_id = $2`, [installmentId, userId]);
  return rows[0] ? mapInstallment(rows[0]) : null;
}

export async function installmentsOf(c: Db, userId: string, invoiceId: string): Promise<InstallmentRow[]> {
  const { rows } = await c.query(
    `${INSTALLMENT_SELECT} where invoice_id = $1 and user_id = $2 order by position`,
    [invoiceId, userId],
  );
  return rows.map(mapInstallment);
}

export async function loadContact(c: Db, userId: string, contactId: string): Promise<ContactRow | null> {
  const { rows } = await c.query<ContactRow>(`${CONTACT_SELECT} where id = $1 and user_id = $2`, [contactId, userId]);
  return rows[0] ?? null;
}

export async function loadStep(c: Db, userId: string, stepId: string): Promise<StepRow | null> {
  const { rows } = await c.query<StepRow>(`${STEP_SELECT} where id = $1 and user_id = $2`, [stepId, userId]);
  return rows[0] ?? null;
}

export async function stepsOf(c: Db, userId: string, sequenceId: string): Promise<StepRow[]> {
  const { rows } = await c.query<StepRow>(
    `${STEP_SELECT} where sequence_id = $1 and user_id = $2 order by offset_days, position`,
    [sequenceId, userId],
  );
  return rows;
}

export async function defaultSequence(c: Db, userId: string, kind: "standard" | "plan"): Promise<SequenceRow> {
  const { rows } = await c.query<SequenceRow>(
    `select id, user_id, kind, is_default from sequences
     where user_id = $1 and kind = $2 and is_default`,
    [userId, kind],
  );
  if (!rows[0]) throw new NotFoundError(`Default ${kind} sequence`);
  return rows[0];
}

// Precedence for open invoices: invoice override, then client, then default.
// An override of the wrong kind is ignored.
export async function standardSequenceFor(c: Db, userId: string, invoice: InvoiceRow, client: ClientRow): Promise<SequenceRow> {
  for (const id of [invoice.sequence_id, client.sequence_id]) {
    if (!id) continue;
    const { rows } = await c.query<SequenceRow>(
      `select id, user_id, kind, is_default from sequences where id = $1 and user_id = $2 and kind = 'standard'`,
      [id, userId],
    );
    if (rows[0]) return rows[0];
  }
  return defaultSequence(c, userId, "standard");
}

export async function primaryContactOfClient(c: Db, userId: string, clientId: string): Promise<ContactRow | null> {
  const { rows } = await c.query<ContactRow>(`${CONTACT_SELECT} where client_id = $1 and user_id = $2 and is_primary`, [clientId, userId]);
  return rows[0] ?? null;
}

export async function primaryContactFor(c: Db, userId: string, invoiceId: string, clientId: string): Promise<ContactRow | null> {
  const fromInvoice = await c.query<ContactRow>(
    `select ct.id, ct.user_id, ct.client_id, ct.email, ct.name, ct.is_primary, ct.hold
     from invoice_contacts ic join contacts ct on ct.id = ic.contact_id
     where ic.invoice_id = $1 and ic.user_id = $2 and ic.role = 'primary'`,
    [invoiceId, userId],
  );
  if (fromInvoice.rows[0]) return fromInvoice.rows[0];
  const fromClient = await c.query<ContactRow>(
    `${CONTACT_SELECT} where client_id = $1 and user_id = $2 and is_primary`,
    [clientId, userId],
  );
  return fromClient.rows[0] ?? null;
}

// Active CC addresses for an invoice, lower-cased, without the primary address.
export async function ccEmailsFor(c: Db, userId: string, invoiceId: string, primaryEmail: string): Promise<string[]> {
  const { rows } = await c.query<{ email: string }>(
    `select distinct ct.email from invoice_contacts ic join contacts ct on ct.id = ic.contact_id
     where ic.invoice_id = $1 and ic.user_id = $2 and ic.role = 'cc' and ct.hold is null
     order by ct.email`,
    [invoiceId, userId],
  );
  const primary = primaryEmail.toLowerCase();
  return rows.map((r) => r.email.toLowerCase()).filter((email) => email !== primary);
}

// Mirrors the factory's Stripe check: a connected_accounts row for provider 'stripe'.
// Reads use it to decide the pay-link line without calling a provider.
export async function stripeConnected(c: Db, userId: string): Promise<boolean> {
  const { rows } = await c.query("select 1 from connected_accounts where user_id = $1 and provider = 'stripe'", [userId]);
  return rows.length > 0;
}

export async function loadMessage(c: Db, userId: string, messageId: string, lock: boolean): Promise<MessageRow | null> {
  const { rows } = await c.query<MessageRow>(
    `${MESSAGE_SELECT} where id = $1 and user_id = $2${lock ? " for update" : ""}`,
    [messageId, userId],
  );
  return rows[0] ?? null;
}

export async function requireMessage(c: Db, userId: string, messageId: string): Promise<MessageRow> {
  const row = await loadMessage(c, userId, messageId, true);
  if (!row) throw new NotFoundError("Message");
  return row;
}

export async function messagesForInvoice(c: Db, userId: string, invoiceId: string): Promise<MessageRow[]> {
  const { rows } = await c.query<MessageRow>(
    `${MESSAGE_SELECT} where invoice_id = $1 and user_id = $2 order by id for update`,
    [invoiceId, userId],
  );
  return rows;
}

// ---- Rule (b) and holds ----------------------------------------------------

export async function hasDispatched(c: Db, userId: string, clientId: string): Promise<boolean> {
  const { rows } = await c.query<{ found: boolean }>(
    `select exists (
       select 1 from message_log m
       join scheduled_messages s on s.id = m.scheduled_message_id
       join contacts ct on ct.id = s.contact_id
       where m.user_id = $1 and ct.client_id = $2
     ) as found`,
    [userId, clientId],
  );
  return rows[0].found;
}

// Rule (b): no message has ever been dispatched to the client and it is not auto-send.
export async function ruleBApplies(c: Db, userId: string, client: ClientRow): Promise<boolean> {
  if (client.auto_send) return false;
  return !(await hasDispatched(c, userId, client.id));
}

export function holdOn(client: ClientRow, contact: ContactRow | null): boolean {
  return client.reply_held_at !== null || (contact !== null && contact.hold !== null);
}

// ---- Row writes ------------------------------------------------------------

export interface MessagePatch {
  status?: MessageStatus;
  prior_status?: string | null;
  planned_at?: Date;
  requires_approval?: boolean;
  contact_id?: string;
  subject_override?: string | null;
  body_override?: string | null;
  claimed_at?: Date | null;
}

export async function updateMessage(c: Db, userId: string, messageId: string, patch: MessagePatch, at: Date): Promise<void> {
  const keys = Object.keys(patch) as (keyof MessagePatch)[];
  const sets = keys.map((key, i) => `${key} = $${i + 3}`);
  sets.push(`updated_at = $${keys.length + 3}`);
  const values: unknown[] = [messageId, userId, ...keys.map((key) => patch[key] ?? null), at];
  await c.query(`update scheduled_messages set ${sets.join(", ")} where id = $1 and user_id = $2`, values);
}

// Cancels every unsent row for an invoice or an installment. The prior status is
// stored so resume can restore it. Writes one event per row, in the same statement.
export async function cancelUnsentWhere(
  c: Db,
  userId: string,
  scope: { invoiceId: string } | { installmentId: string },
  at: Date,
  reason: string,
): Promise<number> {
  const column = "invoiceId" in scope ? "invoice_id" : "installment_id";
  const id = "invoiceId" in scope ? scope.invoiceId : scope.installmentId;
  const result = await c.query(
    `with changed as (
       update scheduled_messages
          set prior_status = case when status = 'held' then prior_status else status end,
              status = 'cancelled', updated_at = $3
        where user_id = $1 and ${column} = $2 and status in ('pending_approval', 'scheduled', 'held')
        returning id, user_id, invoice_id, prior_status
     )
     insert into events (user_id, invoice_id, type, detail, created_at)
     select user_id, invoice_id, 'message_cancelled',
            jsonb_build_object('scheduled_message_id', id, 'prior_status', prior_status, 'reason', $4::text),
            $3
     from changed`,
    [userId, id, at, reason],
  );
  return result.rowCount ?? 0;
}

export async function skipRow(c: Db, userId: string, row: MessageRow, reason: string, at: Date): Promise<void> {
  await updateMessage(c, userId, row.id, { status: "skipped", prior_status: null, claimed_at: null }, at);
  await logEvent(c, {
    userId,
    invoiceId: row.invoice_id,
    type: "message_skipped",
    detail: { scheduled_message_id: row.id, reason, from: row.status },
    at,
  });
}

// Holds an unsent row because of a reason (bounce, reply, contact hold).
export async function holdForReason(c: Db, userId: string, row: MessageRow, reason: string, at: Date): Promise<void> {
  if (row.status !== "pending_approval" && row.status !== "scheduled") return;
  const base: Base = row.status === "pending_approval" ? "pending_approval" : "scheduled";
  await updateMessage(c, userId, row.id, { status: "held", prior_status: encodePrior({ base, userHold: false }) }, at);
  await logEvent(c, {
    userId,
    invoiceId: row.invoice_id,
    type: "message_held",
    detail: { scheduled_message_id: row.id, reason },
    at,
  });
}

export interface RowParties {
  invoice: InvoiceRow;
  client: ClientRow;
  contact: ContactRow | null;
  installment: InstallmentRow | null;
}

export async function partiesFor(c: Db, userId: string, row: MessageRow): Promise<RowParties> {
  const invoice = await loadInvoice(c, userId, row.invoice_id);
  const client = await loadClient(c, userId, invoice.client_id);
  const contact = await loadContact(c, userId, row.contact_id);
  const installment = row.installment_id ? await loadInstallment(c, userId, row.installment_id) : null;
  return { invoice, client, contact, installment };
}

// Resume rule (3.4): reschedule when the planned time is still ahead, otherwise skip.
// Restored rows are never batched; they wait for their own planned time.
export async function restoreRow(c: Db, userId: string, row: MessageRow, at: Date): Promise<void> {
  if (!row.prior_status) {
    await skipRow(c, userId, row, "no_prior_status", at);
    return;
  }
  if (row.planned_at.getTime() <= at.getTime()) {
    await skipRow(c, userId, row, "planned_time_passed", at);
    return;
  }
  const parties = await partiesFor(c, userId, row);
  const ruleB = await ruleBApplies(c, userId, parties.client);
  const next = resolveUnsent(decodePrior(row.prior_status), row.requires_approval, ruleB, holdOn(parties.client, parties.contact));
  await updateMessage(c, userId, row.id, { status: next.status, prior_status: next.prior }, at);
  await logEvent(c, {
    userId,
    invoiceId: row.invoice_id,
    type: "message_resumed",
    detail: { scheduled_message_id: row.id, status: next.status },
    at,
  });
}

// Resume every cancelled row of an invoice. Called after a status moves back to open or payment_plan.
export async function restoreCancelledForInvoice(c: Db, userId: string, invoiceId: string, at: Date): Promise<void> {
  const { rows } = await c.query<MessageRow>(
    `${MESSAGE_SELECT} where invoice_id = $1 and user_id = $2 and status = 'cancelled' order by id for update`,
    [invoiceId, userId],
  );
  for (const row of rows) await restoreRow(c, userId, row, at);
}

// Clears a hold and resumes the held rows it covered. A row stays held while any
// other hold applies, and a manual hold is never released by a reason-based resume.
export async function releaseHeld(
  c: Db,
  userId: string,
  by: { clientId: string } | { contactId: string },
  at: Date,
): Promise<void> {
  const column = "clientId" in by ? "i.client_id" : "m.contact_id";
  const id = "clientId" in by ? by.clientId : by.contactId;
  const { rows } = await c.query<MessageRow>(
    `select m.id, m.user_id, m.invoice_id, m.installment_id, m.step_id, m.contact_id, m.planned_at, m.status,
            m.prior_status, m.requires_approval, m.subject_override, m.body_override, m.claimed_at, m.dedupe_key
     from scheduled_messages m join invoices i on i.id = m.invoice_id
     where m.user_id = $1 and m.status = 'held' and ${column} = $2 order by m.id for update of m`,
    [userId, id],
  );
  for (const row of rows) {
    if (decodePrior(row.prior_status).userHold) continue;
    await restoreRow(c, userId, row, at);
  }
}

// Rule (b) release: the first dispatch to a client, or auto-send switched on,
// moves rows waiting only for rule (b) to scheduled. Rows whose time has passed
// are skipped, never sent late (the stop rule that prevents unwanted messages).
export async function releaseRuleB(c: Db, userId: string, clientId: string, at: Date): Promise<number> {
  const { rows } = await c.query<MessageRow>(
    `${MESSAGE_SELECT} m where m.user_id = $1 and m.status = 'pending_approval' and m.requires_approval = false
       and m.invoice_id in (select id from invoices where client_id = $2 and user_id = $1)
     order by m.id for update`,
    [userId, clientId],
  );
  for (const row of rows) {
    if (row.planned_at.getTime() > at.getTime()) {
      await updateMessage(c, userId, row.id, { status: "scheduled" }, at);
      await logEvent(c, { userId, invoiceId: row.invoice_id, type: "message_released", detail: { scheduled_message_id: row.id, reason: "rule_b" }, at });
    } else {
      await skipRow(c, userId, row, "planned_time_passed", at);
    }
  }
  return rows.length;
}

// Auto-send switched off with no dispatch yet: rule (b) applies again, so rows
// that were scheduled without approval go back to pending approval.
export async function revertRuleB(c: Db, userId: string, clientId: string, at: Date): Promise<number> {
  const { rows } = await c.query<MessageRow>(
    `${MESSAGE_SELECT} m where m.user_id = $1 and m.status = 'scheduled' and m.requires_approval = false
       and m.invoice_id in (select id from invoices where client_id = $2 and user_id = $1)
     order by m.id for update`,
    [userId, clientId],
  );
  for (const row of rows) {
    await updateMessage(c, userId, row.id, { status: "pending_approval" }, at);
    await logEvent(c, { userId, invoiceId: row.invoice_id, type: "message_pending_again", detail: { scheduled_message_id: row.id, reason: "auto_send_off" }, at });
  }
  return rows.length;
}
