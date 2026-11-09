// Read models for Needs you, Next 7 days and the reminder editor. Every query runs
// through withUser, so row-level security applies, and every predicate also filters
// by user_id. Previews call buildMessage in preview mode, the same renderer the sender
// uses, so nothing is created, sent or linked to a payment.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { listNeedsYou, listNextSevenDays, NotFoundError, type NeedsYouItem, type NeedsYouKind } from "@/lib/engine";
import { buildMessage, isSenderProfileComplete, MessageError } from "@/lib/templates";
import type { MessageStatus } from "@/lib/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// Falls back to UTC for a timezone name the runtime does not know.
export function zoneOrUtc(zone: string | null | undefined): string {
  if (zone && DateTime.utc().setZone(zone).isValid) return zone;
  return "UTC";
}

// ---- Settings ----------------------------------------------------------------

export interface SettingsView {
  timezone: string;
  senderName: string;
  businessName: string;
  postalAddress: string;
  onboardingDone: boolean;
}

export async function loadSettingsView(userId: string): Promise<SettingsView> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      timezone: string;
      sender_name: string;
      business_name: string;
      postal_address: string;
      onboarding_done: boolean;
    }>(
      `select timezone, sender_name, business_name, postal_address, onboarding_done
         from settings where user_id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) {
      return { timezone: "UTC", senderName: "", businessName: "", postalAddress: "", onboardingDone: false };
    }
    return {
      timezone: zoneOrUtc(r.timezone),
      senderName: r.sender_name,
      businessName: r.business_name,
      postalAddress: r.postal_address,
      onboardingDone: r.onboarding_done,
    };
  });
}

// ---- Display helpers ---------------------------------------------------------

// "8 Nov 2026"
export function formatDay(date: Date | string, zone: string): string {
  return toZoned(date, zone).toFormat("d LLL yyyy");
}

// "9:00 AM"
export function formatClock(date: Date | string, zone: string): string {
  return toZoned(date, zone).toFormat("h:mm a");
}

// "Due 9:00 AM, Tue 10 Nov"
export function formatPlanned(date: Date | string, zone: string): string {
  const dt = toZoned(date, zone);
  return `${dt.toFormat("h:mm a")}, ${dt.toFormat("EEE d LLL")}`;
}

function toZoned(date: Date | string, zone: string): DateTime {
  const instant = typeof date === "string" ? new Date(date) : date;
  return DateTime.fromJSDate(instant, { zone: zoneOrUtc(zone) }).setLocale("en");
}

// The local calendar date (YYYY-MM-DD) of an instant in the zone.
export function localDay(date: Date | string, zone: string): string {
  return toZoned(date, zone).toISODate() ?? "";
}

// ---- Step descriptions -------------------------------------------------------

const TONE_LABEL: Record<string, string> = { friendly: "Friendly", neutral: "Neutral", firm: "Firm", custom: "Custom" };

export function describeStep(input: {
  hasStep: boolean;
  offsetDays: number | null;
  tone: string | null;
  isFinalNotice: boolean | null;
  isInstallment: boolean;
}): string {
  if (!input.hasStep || input.offsetDays === null) return "Reminder (its step was removed)";
  const kind = input.isFinalNotice ? "Final notice" : `${TONE_LABEL[input.tone ?? "custom"] ?? "Custom"} reminder`;
  const anchor = input.isInstallment ? "the installment due date" : "the due date";
  const days = Math.abs(input.offsetDays);
  let when: string;
  if (input.offsetDays === 0) when = `on ${anchor}`;
  else if (input.offsetDays < 0) when = `${days} ${days === 1 ? "day" : "days"} before ${anchor}`;
  else when = `${days} ${days === 1 ? "day" : "days"} after ${anchor}`;
  return `${kind}, ${when}`;
}

// ---- Reminder details --------------------------------------------------------

export interface ReminderDetail {
  id: string;
  status: MessageStatus;
  plannedAt: string;
  requiresApproval: boolean;
  isInstallment: boolean;
  invoiceId: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  contactEmail: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  stepLabel: string;
  hasStep: boolean;
  // The editor starts from these template texts (the override, else the step).
  subject: string;
  body: string;
  // What the client would read. Null when it cannot be rendered, with a reason.
  preview: { subject: string; text: string } | null;
  previewNote: string | null;
  // The exact text recorded before a provider call, for rows that may have gone out.
  attempt: { subject: string; text: string; recordedAt: string } | null;
}

interface DetailRow {
  id: string;
  status: MessageStatus;
  planned_at: Date;
  requires_approval: boolean;
  installment_id: string | null;
  subject_override: string | null;
  body_override: string | null;
  contact_email: string;
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  client_timezone: string | null;
  invoice_amount: string;
  invoice_currency: string;
  invoice_due: string;
  inst_amount: string | null;
  inst_currency: string | null;
  inst_due: string | null;
  step_offset: number | null;
  step_tone: string | null;
  step_subject: string | null;
  step_body: string | null;
  step_final: boolean | null;
  step_id: string | null;
}

const DETAIL_SQL = `
  select m.id, m.status, m.planned_at, m.requires_approval, m.installment_id,
         m.subject_override, m.body_override, ct.email as contact_email,
         i.id as invoice_id, i.invoice_number, cl.id as client_id, cl.name as client_name,
         cl.timezone as client_timezone,
         i.amount_minor::text as invoice_amount, i.currency as invoice_currency, i.due_date::text as invoice_due,
         p.amount_minor::text as inst_amount, p.currency as inst_currency, p.due_date::text as inst_due,
         st.offset_days as step_offset, st.tone as step_tone, st.subject as step_subject,
         st.body as step_body, st.is_final_notice as step_final, st.id as step_id
    from scheduled_messages m
    join invoices i on i.id = m.invoice_id and i.user_id = m.user_id
    join clients cl on cl.id = i.client_id and cl.user_id = m.user_id
    join contacts ct on ct.id = m.contact_id and ct.user_id = m.user_id
    left join payment_plan_installments p on p.id = m.installment_id and p.user_id = m.user_id
    left join sequence_steps st on st.id = m.step_id and st.user_id = m.user_id
   where m.user_id = $1 and m.id = any($2::uuid[])`;

// Loads the reminders with their invoice, client, step, preview and last recorded attempt.
// Ids that do not belong to the user are simply absent from the result.
export async function loadReminderDetails(userId: string, messageIds: readonly string[]): Promise<Map<string, ReminderDetail>> {
  const ids = [...new Set(messageIds)].filter(isUuid);
  const out = new Map<string, ReminderDetail>();
  if (ids.length === 0) return out;
  return withUser(userId, async (c) => {
    const settings = await settingsRow(c, userId);
    const { rows } = await c.query<DetailRow>(DETAIL_SQL, [userId, ids]);
    const attempts = await latestAttempts(c, userId, ids);

    for (const row of rows) {
      const zone = zoneOrUtc(row.client_timezone || settings.timezone);
      const payable = row.installment_id
        ? { amount: Number(row.inst_amount ?? 0), currency: row.inst_currency ?? row.invoice_currency, due: row.inst_due ?? row.invoice_due }
        : { amount: Number(row.invoice_amount), currency: row.invoice_currency, due: row.invoice_due };
      const preview = renderPreview(row, settings, zone, payable);
      const attempt = attempts.get(row.id) ?? null;
      out.set(row.id, {
        id: row.id,
        status: row.status,
        plannedAt: row.planned_at.toISOString(),
        requiresApproval: row.requires_approval,
        isInstallment: row.installment_id !== null,
        invoiceId: row.invoice_id,
        invoiceNumber: row.invoice_number,
        clientId: row.client_id,
        clientName: row.client_name,
        contactEmail: row.contact_email,
        amountMinor: payable.amount,
        currency: payable.currency,
        dueDate: payable.due,
        stepLabel: describeStep({
          hasStep: row.step_id !== null,
          offsetDays: row.step_offset,
          tone: row.step_tone,
          isFinalNotice: row.step_final,
          isInstallment: row.installment_id !== null,
        }),
        hasStep: row.step_id !== null,
        subject: row.subject_override ?? row.step_subject ?? "",
        body: row.body_override ?? row.step_body ?? "",
        preview: preview.preview,
        previewNote: preview.note,
        attempt,
      });
    }
    return out;
  });
}

interface SettingsRowLite {
  timezone: string;
  senderName: string;
  businessName: string;
  postalAddress: string;
}

async function settingsRow(c: PoolClient, userId: string): Promise<SettingsRowLite> {
  const { rows } = await c.query<{ timezone: string; sender_name: string; business_name: string; postal_address: string }>(
    "select timezone, sender_name, business_name, postal_address from settings where user_id = $1",
    [userId],
  );
  const r = rows[0];
  return {
    timezone: zoneOrUtc(r?.timezone),
    senderName: r?.sender_name ?? "",
    businessName: r?.business_name ?? "",
    postalAddress: r?.postal_address ?? "",
  };
}

async function latestAttempts(c: PoolClient, userId: string, ids: string[]): Promise<Map<string, ReminderDetail["attempt"]>> {
  const { rows } = await c.query<{ message_id: string; detail: Record<string, unknown>; created_at: Date }>(
    `select distinct on (detail->>'scheduled_message_id')
            detail->>'scheduled_message_id' as message_id, detail, created_at
       from events
      where user_id = $1 and type = 'send_attempt' and detail->>'scheduled_message_id' = any($2::text[])
      order by detail->>'scheduled_message_id', id desc`,
    [userId, ids],
  );
  const map = new Map<string, ReminderDetail["attempt"]>();
  for (const r of rows) {
    const body = r.detail.body_snapshot;
    if (typeof body !== "string") continue;
    map.set(r.message_id, {
      subject: typeof r.detail.subject === "string" ? r.detail.subject : "",
      text: body,
      recordedAt: r.created_at.toISOString(),
    });
  }
  return map;
}

function renderPreview(
  row: DetailRow,
  settings: SettingsRowLite,
  zone: string,
  payable: { amount: number; currency: string; due: string },
): { preview: ReminderDetail["preview"]; note: string | null } {
  if (!isSenderProfileComplete({ senderName: settings.senderName, businessName: settings.businessName, postalAddress: settings.postalAddress })) {
    return { preview: null, note: "Finish your sender profile in Settings to see the full message." };
  }
  const template = {
    subject: row.subject_override ?? row.step_subject ?? "",
    body: row.body_override ?? row.step_body ?? "",
  };
  try {
    const built = buildMessage({
      template,
      context: {
        clientName: row.client_name,
        invoiceNumber: row.invoice_number,
        amountMinor: payable.amount,
        currency: payable.currency,
        dueDate: payable.due,
        // Mirrors the sender: zero for steps on or before the due date.
        daysOverdue: Math.max(0, row.step_offset ?? 0),
        senderName: settings.senderName,
        businessName: settings.businessName,
        timezone: zone,
        payLink: null,
      },
      stripeConnected: false,
      sender: { senderName: settings.senderName, businessName: settings.businessName, postalAddress: settings.postalAddress },
      preview: true,
    });
    return { preview: { subject: built.subject, text: built.text }, note: null };
  } catch (err) {
    if (err instanceof MessageError) return { preview: null, note: err.message };
    throw err;
  }
}

// The current address of each bounced contact, and the address its last bounced message went to.
async function loadBounceAddresses(
  userId: string,
  contactIds: readonly string[],
): Promise<Map<string, { currentEmail: string; bouncedEmail: string | null }>> {
  const out = new Map<string, { currentEmail: string; bouncedEmail: string | null }>();
  const ids = [...new Set(contactIds)].filter(isUuid);
  if (ids.length === 0) return out;
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ id: string; current_email: string; bounced_email: string | null }>(
      `select ct.id, ct.email as current_email,
              (select l.recipient_email from message_log l
                where l.user_id = ct.user_id and l.contact_id = ct.id and l.delivery_status = 'bounced'
                order by l.sent_at desc limit 1) as bounced_email
         from contacts ct where ct.user_id = $1 and ct.id = any($2::uuid[])`,
      [userId, ids],
    );
    for (const r of rows) out.set(r.id, { currentEmail: r.current_email, bouncedEmail: r.bounced_email });
    return out;
  });
}

// ---- Needs you ---------------------------------------------------------------

export interface NeedsYouRow extends Omit<NeedsYouItem, "plannedAt"> {
  plannedLabel: string | null;
  reminder: ReminderDetail | null;
  // For a bounce: the address the contact has now, and the address that bounced. The address
  // counts as fixed once the two differ. The engine keeps the hold when the address changes.
  bounce: { currentEmail: string; bouncedEmail: string | null } | null;
}

export interface NeedsYouSection {
  kind: NeedsYouKind;
  heading: string;
  explanation: string;
  rows: NeedsYouRow[];
}

export interface NeedsYouView {
  timezone: string;
  total: number;
  sections: NeedsYouSection[];
}

// Display order: money-at-risk first (approvals, failures), then the things that stop
// reminders (replies, bounces), then informational items.
export const NEEDS_YOU_SECTIONS: { kind: NeedsYouKind; heading: string; explanation: string }[] = [
  { kind: "approval", heading: "Awaiting your approval", explanation: "Nothing goes out until you approve these." },
  { kind: "failed", heading: "Failed to send", explanation: "The email provider refused these before accepting them." },
  { kind: "needs_check", heading: "Check whether these were delivered", explanation: "These may already have gone out. They are never sent again automatically." },
  { kind: "reply", heading: "Clients who replied", explanation: "Reminders to these clients are on hold until you resume them." },
  { kind: "bounce", heading: "Bounced addresses", explanation: "Nothing more goes to these addresses until you fix them and resume." },
  { kind: "disputed", heading: "Disputed invoices", explanation: "Reminders stop while an invoice is disputed." },
  { kind: "paid_while_disputed", heading: "Paid while disputed", explanation: "A payment arrived while these invoices were disputed or written off. Check the dispute is resolved, then mark it as reviewed." },
];

export async function loadNeedsYou(userId: string): Promise<NeedsYouView> {
  const [settings, items] = await Promise.all([loadSettingsView(userId), listNeedsYou(userId)]);
  const messageIds = items.flatMap((item) => (item.messageId ? [item.messageId] : []));
  const details = await loadReminderDetails(userId, messageIds);
  const bounceContacts = items.flatMap((item) => (item.kind === "bounce" && item.contactId ? [item.contactId] : []));
  const bounces = await loadBounceAddresses(userId, bounceContacts);

  const rows: NeedsYouRow[] = items.map((item) => {
    const { plannedAt, ...rest } = item;
    return {
      ...rest,
      plannedLabel: plannedAt ? formatPlanned(plannedAt, settings.timezone) : null,
      reminder: item.messageId ? (details.get(item.messageId) ?? null) : null,
      bounce: item.contactId && item.kind === "bounce" ? (bounces.get(item.contactId) ?? null) : null,
    };
  });

  const sections = NEEDS_YOU_SECTIONS.map((section) => ({
    ...section,
    rows: rows.filter((row) => row.kind === section.kind),
  })).filter((section) => section.rows.length > 0);

  return { timezone: settings.timezone, total: items.length, sections };
}

// ---- Next 7 days -------------------------------------------------------------

export interface NextSevenDaysGroup {
  day: string;
  label: string;
  reminders: Array<ReminderDetail & { timeLabel: string }>;
}

export interface NextSevenDaysView {
  timezone: string;
  count: number;
  groups: NextSevenDaysGroup[];
}

export async function loadNextSevenDays(userId: string, clock: Clock): Promise<NextSevenDaysView> {
  const [settings, upcoming] = await Promise.all([loadSettingsView(userId), listNextSevenDays(userId, clock)]);
  const details = await loadReminderDetails(userId, upcoming.map((u) => u.messageId));
  const today = localDay(clock.now(), settings.timezone);
  const tomorrow = DateTime.fromISO(today, { zone: "utc" }).plus({ days: 1 }).toISODate();

  const groups = new Map<string, NextSevenDaysGroup>();
  for (const item of upcoming) {
    const detail = details.get(item.messageId);
    if (!detail) continue;
    const day = localDay(item.plannedAt, settings.timezone);
    const group = groups.get(day) ?? {
      day,
      label: dayLabel(day, today, tomorrow),
      reminders: [],
    };
    group.reminders.push({ ...detail, timeLabel: formatClock(item.plannedAt, settings.timezone) });
    groups.set(day, group);
  }

  return {
    timezone: settings.timezone,
    count: upcoming.length,
    groups: [...groups.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function dayLabel(day: string, today: string | null, tomorrow: string | null): string {
  if (day === today) return "Today";
  if (day === tomorrow) return "Tomorrow";
  return DateTime.fromISO(day, { zone: "utc" }).setLocale("en").toFormat("EEEE d LLL");
}

// The held reminders for one client. Throws NotFoundError when the client is not the user's.
export async function heldMessageIdsForClient(userId: string, clientId: string): Promise<string[]> {
  if (!isUuid(clientId)) throw new NotFoundError("Client");
  return withUser(userId, async (c) => {
    const owned = await c.query("select 1 from clients where id = $1 and user_id = $2", [clientId, userId]);
    if (owned.rowCount === 0) throw new NotFoundError("Client");
    const { rows } = await c.query<{ id: string }>(
      `select m.id from scheduled_messages m join invoices i on i.id = m.invoice_id
        where m.user_id = $1 and i.client_id = $2 and m.status = 'held' order by m.planned_at, m.id`,
      [userId, clientId],
    );
    return rows.map((r) => r.id);
  });
}
