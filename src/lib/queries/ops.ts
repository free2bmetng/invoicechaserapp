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

// "Thu 12 Nov at 9:00 AM"
export function formatWhen(date: Date | string, zone: string): string {
  const dt = toZoned(date, zone);
  return `${dt.toFormat("EEE d LLL")} at ${dt.toFormat("h:mm a")}`;
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

// The compact form for queue rows: "3 days before due", "On the due date", "7 days after due".
export function describeStepShort(input: {
  hasStep: boolean;
  offsetDays: number | null;
  isFinalNotice: boolean | null;
  isInstallment: boolean;
}): string {
  if (!input.hasStep || input.offsetDays === null) return "Step removed";
  const anchor = input.isInstallment ? "installment due" : "due";
  const days = Math.abs(input.offsetDays);
  const when =
    input.offsetDays === 0
      ? `On the ${input.isInstallment ? "installment " : ""}due date`
      : `${days} ${days === 1 ? "day" : "days"} ${input.offsetDays < 0 ? "before" : "after"} ${anchor}`;
  return input.isFinalNotice ? `Final notice, ${when.charAt(0).toLowerCase()}${when.slice(1)}` : when;
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
  // "7 days after due", for compact rows.
  stepShort: string;
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
        stepShort: describeStepShort({
          hasStep: row.step_id !== null,
          offsetDays: row.step_offset,
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

export interface MoneyAmount {
  amountMinor: number;
  currency: string;
}

export interface NeedsYouRow extends Omit<NeedsYouItem, "plannedAt"> {
  plannedLabel: string | null;
  reminder: ReminderDetail | null;
  // For a bounce: the address the contact has now, and the address that bounced. The address
  // counts as fixed once the two differ. The engine keeps the hold when the address changes.
  bounce: { currentEmail: string; bouncedEmail: string | null } | null;
  // Queue rows lead with the client, so the row's own line never repeats it.
  clientName: string | null;
  invoiceNumber: string | null;
  // The short line beside the client: what the item is about, then a quieter detail.
  line: { title: string; meta: string | null };
  // The money this item holds up: the reminder's payable, the disputed invoice, or for a
  // reply or bounce the client's outstanding balance. One entry per currency, never added up.
  atStake: MoneyAmount[];
  // For approvals: how many reminders on the same invoice are awaiting approval (this one included).
  invoiceApprovals: number;
  // For replies: how many reminders are held for the client.
  heldCount: number;
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

// Display order, by urgency (DESIGN_V2): things that broke come first (failed sends, sends
// that may or may not have gone out, bounced addresses), then decisions that hold money up
// (approvals, replies), then informational items.
export const NEEDS_YOU_SECTIONS: { kind: NeedsYouKind; heading: string; explanation: string }[] = [
  { kind: "failed", heading: "Failed to send", explanation: "The email provider refused these. Retry or cancel them." },
  { kind: "needs_check", heading: "Check delivery", explanation: "These may already have gone out. They are never sent again automatically." },
  { kind: "bounce", heading: "Bounced addresses", explanation: "Nothing more goes to these addresses until you fix them and resume." },
  { kind: "approval", heading: "Awaiting your approval", explanation: "Nothing goes out until you approve it." },
  { kind: "reply", heading: "Clients who replied", explanation: "Reminders to these clients are on hold until you resume them." },
  { kind: "paid_while_disputed", heading: "Paid while disputed", explanation: "A payment arrived while these were disputed or written off. Check the dispute is resolved." },
  { kind: "disputed", heading: "Disputed invoices", explanation: "Reminders stay stopped while an invoice is disputed." },
];

interface RowContext {
  clients: Map<string, { name: string; outstanding: MoneyAmount[]; held: number }>;
  invoices: Map<string, { number: string; amount: MoneyAmount }>;
}

// Client names, outstanding balances and held counts, and invoice numbers and amounts, for the
// rows that do not carry a reminder. Ids outside the user's account are simply absent.
async function loadRowContext(userId: string, clientIds: readonly string[], invoiceIds: readonly string[]): Promise<RowContext> {
  const cIds = [...new Set(clientIds)].filter(isUuid);
  const iIds = [...new Set(invoiceIds)].filter(isUuid);
  const out: RowContext = { clients: new Map(), invoices: new Map() };
  if (cIds.length === 0 && iIds.length === 0) return out;
  return withUser(userId, async (c) => {
    if (cIds.length > 0) {
      const names = await c.query<{ id: string; name: string; held: string }>(
        `select cl.id, cl.name,
                (select count(*) from scheduled_messages m join invoices i on i.id = m.invoice_id
                  where m.user_id = cl.user_id and i.client_id = cl.id and m.status = 'held')::text as held
           from clients cl where cl.user_id = $1 and cl.id = any($2::uuid[])`,
        [userId, cIds],
      );
      for (const r of names.rows) out.clients.set(r.id, { name: r.name, outstanding: [], held: Number(r.held) });
      const owed = await c.query<{ client_id: string; currency: string; amount: string }>(
        `with payables as (
           select i.client_id, i.currency, i.amount_minor as amount
             from invoices i
            where i.user_id = $1 and i.client_id = any($2::uuid[]) and i.status in ('open', 'paused', 'disputed')
              and not exists (select 1 from payment_plan_installments p where p.invoice_id = i.id)
           union all
           select i.client_id, p.currency, p.amount_minor
             from payment_plan_installments p join invoices i on i.id = p.invoice_id
            where p.user_id = $1 and i.client_id = any($2::uuid[]) and p.status = 'open'
              and i.status in ('open', 'payment_plan', 'paused', 'disputed')
         )
         select client_id, currency, sum(amount)::text as amount from payables group by client_id, currency order by currency`,
        [userId, cIds],
      );
      for (const r of owed.rows) out.clients.get(r.client_id)?.outstanding.push({ amountMinor: Number(r.amount), currency: r.currency });
    }
    if (iIds.length > 0) {
      const invoices = await c.query<{ id: string; invoice_number: string; amount_minor: string; currency: string }>(
        "select id, invoice_number, amount_minor::text, currency from invoices where user_id = $1 and id = any($2::uuid[])",
        [userId, iIds],
      );
      for (const r of invoices.rows) {
        out.invoices.set(r.id, { number: r.invoice_number, amount: { amountMinor: Number(r.amount_minor), currency: r.currency } });
      }
    }
    return out;
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The short row line. The client leads the row, so it is never repeated here.
function rowLine(item: NeedsYouItem, reminder: ReminderDetail | null, invoiceNumber: string | null, held: number): NeedsYouRow["line"] {
  const number = invoiceNumber ?? "Invoice";
  switch (item.kind) {
    case "approval":
    case "failed":
    case "needs_check":
      return { title: number, meta: reminder?.stepShort ?? null };
    case "bounce":
      return { title: item.title.replace(/ bounced for .*$/, ""), meta: null };
    case "reply":
      return { title: held > 0 ? `${plural(held, "reminder", "reminders")} on hold` : "Replied", meta: null };
    case "disputed":
    case "paid_while_disputed":
      return { title: number, meta: null };
  }
}

export async function loadNeedsYou(userId: string): Promise<NeedsYouView> {
  const [settings, items] = await Promise.all([loadSettingsView(userId), listNeedsYou(userId)]);
  const messageIds = items.flatMap((item) => (item.messageId ? [item.messageId] : []));
  const details = await loadReminderDetails(userId, messageIds);
  const bounceContacts = items.flatMap((item) => (item.kind === "bounce" && item.contactId ? [item.contactId] : []));
  const bounces = await loadBounceAddresses(userId, bounceContacts);

  const context = await loadRowContext(
    userId,
    items.flatMap((item) => (item.clientId ? [item.clientId] : [])),
    items.flatMap((item) => (item.invoiceId && !item.messageId ? [item.invoiceId] : [])),
  );
  const approvalsPerInvoice = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "approval" && item.invoiceId) {
      approvalsPerInvoice.set(item.invoiceId, (approvalsPerInvoice.get(item.invoiceId) ?? 0) + 1);
    }
  }

  const rows: NeedsYouRow[] = items.map((item) => {
    const { plannedAt, ...rest } = item;
    const reminder = item.messageId ? (details.get(item.messageId) ?? null) : null;
    const client = item.clientId ? context.clients.get(item.clientId) : undefined;
    const invoice = item.invoiceId ? context.invoices.get(item.invoiceId) : undefined;
    const invoiceNumber = reminder?.invoiceNumber ?? invoice?.number ?? null;
    const held = client?.held ?? 0;
    let atStake: MoneyAmount[] = [];
    if (reminder) atStake = [{ amountMinor: reminder.amountMinor, currency: reminder.currency }];
    else if (invoice) atStake = [invoice.amount];
    else if (client && (item.kind === "reply" || item.kind === "bounce")) atStake = client.outstanding;
    return {
      ...rest,
      plannedLabel: plannedAt ? formatPlanned(plannedAt, settings.timezone) : null,
      reminder,
      bounce: item.contactId && item.kind === "bounce" ? (bounces.get(item.contactId) ?? null) : null,
      clientName: reminder?.clientName ?? client?.name ?? null,
      invoiceNumber,
      line: rowLine(item, reminder, invoiceNumber, held),
      atStake,
      invoiceApprovals: item.kind === "approval" && item.invoiceId ? (approvalsPerInvoice.get(item.invoiceId) ?? 1) : 0,
      heldCount: held,
    };
  });

  // Approvals for the same invoice sit together (in the order of each invoice's first one), so
  // "Approve all N" covers a visible run of rows.
  const firstSeen = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind === "approval" && row.invoiceId && !firstSeen.has(row.invoiceId)) firstSeen.set(row.invoiceId, index);
  });
  const groupOrder = (row: NeedsYouRow, index: number) => (row.invoiceId ? (firstSeen.get(row.invoiceId) ?? index) : index);

  const sections = NEEDS_YOU_SECTIONS.map((section) => {
    const matching = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === section.kind);
    if (section.kind === "approval") {
      matching.sort((a, b) => groupOrder(a.row, a.index) - groupOrder(b.row, b.index) || a.index - b.index);
    }
    return { ...section, rows: matching.map(({ row }) => row) };
  }).filter((section) => section.rows.length > 0);

  return { timezone: settings.timezone, total: items.length, sections };
}

// ---- Next 7 days -------------------------------------------------------------

export interface NextSevenDaysGroup {
  day: string;
  label: string;
  // "Tue 10 Nov", shown beside "Today" and "Tomorrow".
  dateLabel: string;
  reminders: Array<ReminderDetail & { timeLabel: string }>;
}

// One cell of the 7-day strip. Days with nothing planned are included, so the strip is a week.
export interface StripDay {
  day: string;
  weekday: string;
  dayOfMonth: string;
  isToday: boolean;
  count: number;
  totals: MoneyAmount[];
}

export interface NextSevenDaysView {
  timezone: string;
  count: number;
  groups: NextSevenDaysGroup[];
  days: StripDay[];
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
      dateLabel: DateTime.fromISO(day, { zone: "utc" }).setLocale("en").toFormat("EEE d LLL"),
      reminders: [],
    };
    group.reminders.push({ ...detail, timeLabel: formatClock(item.plannedAt, settings.timezone) });
    groups.set(day, group);
  }

  const days: StripDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = DateTime.fromISO(today, { zone: "utc" }).plus({ days: offset }).setLocale("en");
    const day = date.toISODate() ?? "";
    const reminders = groups.get(day)?.reminders ?? [];
    const totals = new Map<string, number>();
    for (const r of reminders) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMinor);
    days.push({
      day,
      weekday: date.toFormat("EEE"),
      dayOfMonth: date.toFormat("d"),
      isToday: offset === 0,
      count: reminders.length,
      totals: [...totals.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor })),
    });
  }

  return {
    timezone: settings.timezone,
    count: upcoming.length,
    groups: [...groups.values()].sort((a, b) => a.day.localeCompare(b.day)),
    days,
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

// The reminders on one invoice that are awaiting approval, oldest planned first. Throws
// NotFoundError when the invoice is not the user's. Used by "Approve all N for <invoice>".
export async function pendingApprovalIdsForInvoice(userId: string, invoiceId: string): Promise<string[]> {
  if (!isUuid(invoiceId)) throw new NotFoundError("Invoice");
  return withUser(userId, async (c) => {
    const owned = await c.query("select 1 from invoices where id = $1 and user_id = $2", [invoiceId, userId]);
    if (owned.rowCount === 0) throw new NotFoundError("Invoice");
    const { rows } = await c.query<{ id: string }>(
      `select id from scheduled_messages
        where user_id = $1 and invoice_id = $2 and status = 'pending_approval' order by planned_at, id`,
      [userId, invoiceId],
    );
    return rows.map((r) => r.id);
  });
}
