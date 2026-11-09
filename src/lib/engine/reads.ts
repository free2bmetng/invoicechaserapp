// Read helpers for the UI. Every read runs through withUser, so RLS scopes it to the
// caller. Nothing here returns secrets, payment-link URLs or provider credentials.
import { DateTime } from "luxon";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import type { InvoiceStatus } from "@/lib/types";
import { NotFoundError } from "./errors";
import * as S from "./store";
import { localDateString } from "./window";
import { attemptedText, previewRow, type RenderNote } from "./render";

export interface MoneyTotal {
  currency: string;
  amountMinor: number;
}

export type { RenderNote };

export interface InvoiceListItem {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  amountMinor: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  paidAt: Date | null;
  sequenceId: string | null;
  hasPaymentPlan: boolean;
  nextPlannedAt: Date | null;
}

export interface InvoiceListFilter {
  status?: InvoiceStatus;
  clientId?: string;
  // Matches the invoice number or the client name, case-insensitively.
  search?: string;
  limit?: number;
}

export interface ClientListItem {
  id: string;
  name: string;
  email: string;
  timezone: string | null;
  sequenceId: string | null;
  autoSend: boolean;
  replyHeldAt: Date | null;
  contactCount: number;
  // Per currency. Never added across currencies.
  outstanding: MoneyTotal[];
  overdue: MoneyTotal[];
  lastContactAt: Date | null;
  // Mean of (paid date - issue date) across paid invoices. Secondary figure.
  averageDaysToPay: number | null;
  // Mean of (paid date - due date) across paid invoices. Negative means paid early.
  // The headline: "typically pays X days late".
  avgDaysLate: number | null;
}

export interface ContactView {
  id: string;
  name: string;
  email: string;
  isPrimary: boolean;
  hold: string | null;
}

export interface InstallmentView {
  id: string;
  position: number;
  dueDate: string;
  amountMinor: number;
  currency: string;
  status: "open" | "paid";
  paidAt: Date | null;
}

export interface MessageView {
  id: string;
  status: string;
  priorStatus: string | null;
  plannedAt: Date;
  requiresApproval: boolean;
  installmentId: string | null;
  stepOffsetDays: number | null;
  stepTone: string | null;
  contactEmail: string;
  // sent: the stored text. attempt: the text recorded before a call that may have happened.
  // rendered: what the client will receive if the message goes out as planned.
  textSource: "sent" | "attempt" | "rendered";
  subject: string | null;
  body: string | null;
  // Set for rendered text only.
  render: RenderNote | null;
  // Set once a provider call was made for this message.
  sent: {
    sentAt: Date;
    providerMessageId: string | null;
    deliveryStatus: string;
    manual: boolean;
    subject: string;
    bodySnapshot: string;
  } | null;
}

export interface EventView {
  id: string;
  type: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface InvoiceDetail {
  invoice: InvoiceListItem & { notes: string; source: string; externalId: string | null };
  client: { id: string; name: string; email: string; timezone: string | null; sequenceId: string | null; autoSend: boolean; replyHeldAt: Date | null };
  contacts: { primary: ContactView | null; cc: ContactView[] };
  installments: InstallmentView[];
  // Messages with their send records, in planned order.
  messages: MessageView[];
  // The invoice's event timeline, newest first. Send attempts are internal and left out.
  events: EventView[];
}

export interface ClientDetail {
  id: string;
  name: string;
  email: string;
  timezone: string | null;
  sequenceId: string | null;
  autoSend: boolean;
  replyHeldAt: Date | null;
  contacts: ContactView[];
}

export async function listInvoices(userId: string, filter: InvoiceListFilter = {}): Promise<InvoiceListItem[]> {
  return withUser(userId, async (c) => {
    const params: unknown[] = [userId];
    let where = "i.user_id = $1";
    if (filter.status) {
      params.push(filter.status);
      where += ` and i.status = $${params.length}`;
    }
    if (filter.clientId) {
      params.push(filter.clientId);
      where += ` and i.client_id = $${params.length}`;
    }
    if (filter.search && filter.search.trim() !== "") {
      params.push(`%${filter.search.trim()}%`);
      where += ` and (i.invoice_number ilike $${params.length} or cl.name ilike $${params.length})`;
    }
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 500), 1), 2000);
    params.push(limit);
    const { rows } = await c.query<{
      id: string; invoice_number: string; client_id: string; client_name: string; amount_minor: string; currency: string;
      issue_date: string; due_date: string; status: InvoiceStatus; paid_at: Date | null; sequence_id: string | null;
      has_plan: boolean; next_planned_at: Date | null;
    }>(
      `select i.id, i.invoice_number, i.client_id, cl.name as client_name, i.amount_minor::text as amount_minor,
         i.currency, i.issue_date::text as issue_date, i.due_date::text as due_date, i.status, i.paid_at, i.sequence_id,
         exists (select 1 from payment_plan_installments p where p.invoice_id = i.id) as has_plan,
         (select min(m.planned_at) from scheduled_messages m
            where m.invoice_id = i.id and m.status in ('pending_approval', 'scheduled', 'held')) as next_planned_at
       from invoices i join clients cl on cl.id = i.client_id
       where ${where}
       order by i.due_date desc, i.invoice_number
       limit $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      clientId: r.client_id,
      clientName: r.client_name,
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      status: r.status,
      paidAt: r.paid_at,
      sequenceId: r.sequence_id,
      hasPaymentPlan: r.has_plan,
      nextPlannedAt: r.next_planned_at,
    }));
  });
}

export async function listClients(userId: string, clock: Clock): Promise<ClientListItem[]> {
  return withUser(userId, async (c) => {
    const settings = await S.loadSettings(c, userId);
    const today = localDateString(clock.now(), settings.timezone);

    const clients = await c.query<{
      id: string; name: string; email: string; timezone: string | null; sequence_id: string | null;
      auto_send: boolean; reply_held_at: Date | null; contact_count: string;
    }>(
      `select cl.id, cl.name, cl.email, cl.timezone, cl.sequence_id, cl.auto_send, cl.reply_held_at,
         (select count(*)::text from contacts ct where ct.client_id = cl.id) as contact_count
       from clients cl where cl.user_id = $1 order by cl.name, cl.id`,
      [userId],
    );

    // Unpaid payables: open, paused and disputed invoices, plus open installments of payment plans.
    const payables = await c.query<{ client_id: string; currency: string; amount: string; due: string }>(
      `select i.client_id, i.currency, i.amount_minor::text as amount, i.due_date::text as due
         from invoices i where i.user_id = $1 and i.status in ('open', 'paused', 'disputed')
       union all
       select i.client_id, p.currency, p.amount_minor::text, p.due_date::text
         from payment_plan_installments p join invoices i on i.id = p.invoice_id
         where p.user_id = $1 and p.status = 'open' and i.status = 'payment_plan'`,
      [userId],
    );

    const paid = await c.query<{ client_id: string; issue_date: string; due_date: string; paid_at: Date }>(
      `select client_id, issue_date::text as issue_date, due_date::text as due_date, paid_at from invoices
       where user_id = $1 and status = 'paid' and paid_at is not null`,
      [userId],
    );

    const contacted = await c.query<{ client_id: string; last: Date }>(
      `select i.client_id, max(m.sent_at) as last from message_log m join invoices i on i.id = m.invoice_id
       where m.user_id = $1 group by i.client_id`,
      [userId],
    );

    const outstanding = new Map<string, Map<string, number>>();
    const overdue = new Map<string, Map<string, number>>();
    const add = (map: Map<string, Map<string, number>>, client: string, currency: string, amount: number) => {
      const byCurrency = map.get(client) ?? new Map<string, number>();
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
      map.set(client, byCurrency);
    };
    for (const p of payables.rows) {
      const amount = Number(p.amount);
      add(outstanding, p.client_id, p.currency, amount);
      if (p.due < today) add(overdue, p.client_id, p.currency, amount);
    }

    const days = new Map<string, number[]>();
    const late = new Map<string, number[]>();
    for (const p of paid.rows) {
      const paidOn = DateTime.fromISO(localDateString(p.paid_at, settings.timezone), { zone: "utc" });
      const fromIssue = paidOn.diff(DateTime.fromISO(p.issue_date, { zone: "utc" }), "days").days;
      const fromDue = paidOn.diff(DateTime.fromISO(p.due_date, { zone: "utc" }), "days").days;
      days.set(p.client_id, [...(days.get(p.client_id) ?? []), fromIssue]);
      late.set(p.client_id, [...(late.get(p.client_id) ?? []), fromDue]);
    }
    const mean = (values: number[]): number | null =>
      values.length > 0 ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;

    const lastContact = new Map<string, Date>();
    for (const row of contacted.rows) lastContact.set(row.client_id, row.last);

    const toTotals = (map: Map<string, number> | undefined): MoneyTotal[] =>
      [...(map ?? new Map<string, number>()).entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));

    return clients.rows.map((cl) => {
      const reply = cl.reply_held_at;
      const sent = lastContact.get(cl.id);
      const candidates = [sent, reply].filter((d): d is Date => d instanceof Date);
      const last = candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
      const daysList = days.get(cl.id) ?? [];
      return {
        id: cl.id,
        name: cl.name,
        email: cl.email,
        timezone: cl.timezone,
        sequenceId: cl.sequence_id,
        autoSend: cl.auto_send,
        replyHeldAt: reply,
        contactCount: Number(cl.contact_count),
        outstanding: toTotals(outstanding.get(cl.id)),
        overdue: toTotals(overdue.get(cl.id)),
        lastContactAt: last,
        averageDaysToPay: mean(daysList),
        avgDaysLate: mean(late.get(cl.id) ?? []),
      };
    });
  });
}

export async function getInvoiceDetail(userId: string, invoiceId: string): Promise<InvoiceDetail> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      id: string; invoice_number: string; client_id: string; client_name: string; amount_minor: string; currency: string;
      issue_date: string; due_date: string; status: InvoiceStatus; paid_at: Date | null; sequence_id: string | null;
      notes: string; source: string; external_id: string | null; has_plan: boolean; next_planned_at: Date | null;
    }>(
      `select i.id, i.invoice_number, i.client_id, cl.name as client_name, i.amount_minor::text as amount_minor, i.currency,
         i.issue_date::text as issue_date, i.due_date::text as due_date, i.status, i.paid_at, i.sequence_id, i.notes,
         i.source, i.external_id,
         exists (select 1 from payment_plan_installments p where p.invoice_id = i.id) as has_plan,
         (select min(m.planned_at) from scheduled_messages m
            where m.invoice_id = i.id and m.status in ('pending_approval', 'scheduled', 'held')) as next_planned_at
       from invoices i join clients cl on cl.id = i.client_id
       where i.id = $1 and i.user_id = $2`,
      [invoiceId, userId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundError("Invoice");

    const client = await c.query<{
      id: string; name: string; email: string; timezone: string | null; sequence_id: string | null; auto_send: boolean; reply_held_at: Date | null;
    }>(
      "select id, name, email, timezone, sequence_id, auto_send, reply_held_at from clients where id = $1 and user_id = $2",
      [r.client_id, userId],
    );
    const cl = client.rows[0];

    const contacts = await c.query<{ id: string; name: string; email: string; is_primary: boolean; hold: string | null; role: string }>(
      `select ct.id, ct.name, ct.email, ct.is_primary, ct.hold, ic.role
       from invoice_contacts ic join contacts ct on ct.id = ic.contact_id
       where ic.invoice_id = $1 and ic.user_id = $2 order by ic.role, ct.email`,
      [invoiceId, userId],
    );
    const view = (x: { id: string; name: string; email: string; is_primary: boolean; hold: string | null }): ContactView => ({
      id: x.id, name: x.name, email: x.email, isPrimary: x.is_primary, hold: x.hold,
    });
    const primary = contacts.rows.find((x) => x.role === "primary");

    const installments = await c.query<{
      id: string; position: number; due_date: string; amount_minor: string; currency: string; status: "open" | "paid"; paid_at: Date | null;
    }>(
      `select id, position, due_date::text as due_date, amount_minor::text as amount_minor, currency, status, paid_at
       from payment_plan_installments where invoice_id = $1 and user_id = $2 order by position`,
      [invoiceId, userId],
    );

    const messageRows = await c.query<{
      id: string; status: string; prior_status: string | null; planned_at: Date; requires_approval: boolean;
      installment_id: string | null; offset_days: number | null; tone: string | null; contact_email: string;
      sent_at: Date | null; provider_message_id: string | null; delivery_status: string | null;
      manual: boolean | null; sent_subject: string | null; body_snapshot: string | null;
    }>(
      `select m.id, m.status, m.prior_status, m.planned_at, m.requires_approval, m.installment_id,
         st.offset_days, st.tone, ct.email as contact_email,
         ml.sent_at, ml.provider_message_id, ml.delivery_status, ml.manual, ml.subject as sent_subject, ml.body_snapshot
       from scheduled_messages m
         join contacts ct on ct.id = m.contact_id
         left join sequence_steps st on st.id = m.step_id
         left join message_log ml on ml.scheduled_message_id = m.id
       where m.invoice_id = $1 and m.user_id = $2
       order by m.planned_at, m.id`,
      [invoiceId, userId],
    );
    const settings = await S.loadSettings(c, userId);
    const stripe = await S.stripeConnected(c, userId);
    const messages: MessageView[] = [];
    for (const m of messageRows.rows) {
      const base = {
        id: m.id,
        status: m.status,
        priorStatus: m.prior_status,
        plannedAt: m.planned_at,
        requiresApproval: m.requires_approval,
        installmentId: m.installment_id,
        stepOffsetDays: m.offset_days,
        stepTone: m.tone,
        contactEmail: m.contact_email,
        sent: m.sent_at
          ? {
              sentAt: m.sent_at,
              providerMessageId: m.provider_message_id,
              deliveryStatus: m.delivery_status ?? "sent",
              manual: m.manual ?? false,
              subject: m.sent_subject ?? "",
              bodySnapshot: m.body_snapshot ?? "",
            }
          : null,
      };
      if (m.sent_at) {
        messages.push({ ...base, textSource: "sent", subject: m.sent_subject ?? "", body: m.body_snapshot ?? "", render: null });
        continue;
      }
      if (m.status === "needs_check") {
        const attempted = await attemptedText(c, userId, m.id);
        if (attempted) {
          messages.push({ ...base, textSource: "attempt", subject: attempted.subject, body: attempted.body, render: null });
          continue;
        }
      }
      const row = await S.loadMessage(c, userId, m.id, false);
      if (!row) continue;
      const preview = await previewRow(c, userId, row, { settings, stripeConnected: stripe });
      messages.push({
        ...base,
        textSource: "rendered",
        subject: preview.subject,
        body: preview.body,
        render: {
          footerIncluded: preview.footerIncluded,
          profileComplete: preview.profileComplete,
          paymentLink: preview.paymentLink,
          renderError: preview.renderError,
        },
      });
    }

    const events = await c.query<{ id: string; type: string; detail: Record<string, unknown>; created_at: Date }>(
      `select id, type, detail, created_at from events
       where invoice_id = $1 and user_id = $2 and type <> 'send_attempt' order by id desc limit 200`,
      [invoiceId, userId],
    );

    return {
      invoice: {
        id: r.id,
        invoiceNumber: r.invoice_number,
        clientId: r.client_id,
        clientName: r.client_name,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        status: r.status,
        paidAt: r.paid_at,
        sequenceId: r.sequence_id,
        hasPaymentPlan: r.has_plan,
        nextPlannedAt: r.next_planned_at,
        notes: r.notes,
        source: r.source,
        externalId: r.external_id,
      },
      client: {
        id: cl.id,
        name: cl.name,
        email: cl.email,
        timezone: cl.timezone,
        sequenceId: cl.sequence_id,
        autoSend: cl.auto_send,
        replyHeldAt: cl.reply_held_at,
      },
      contacts: {
        primary: primary ? view(primary) : null,
        cc: contacts.rows.filter((x) => x.role === "cc").map(view),
      },
      installments: installments.rows.map((p) => ({
        id: p.id,
        position: p.position,
        dueDate: p.due_date,
        amountMinor: Number(p.amount_minor),
        currency: p.currency,
        status: p.status,
        paidAt: p.paid_at,
      })),
      messages,
      events: events.rows.map((e) => ({ id: e.id, type: e.type, detail: e.detail, createdAt: e.created_at })),
    };
  });
}

export async function getClientDetail(userId: string, clientId: string): Promise<ClientDetail> {
  return withUser(userId, async (c) => {
    const client = await S.loadClient(c, userId, clientId);
    const contacts = await c.query<{ id: string; name: string; email: string; is_primary: boolean; hold: string | null }>(
      `select id, name, email, is_primary, hold from contacts where client_id = $1 and user_id = $2
       order by is_primary desc, email`,
      [clientId, userId],
    );
    return {
      id: client.id,
      name: client.name,
      email: client.email,
      timezone: client.timezone,
      sequenceId: client.sequence_id,
      autoSend: client.auto_send,
      replyHeldAt: client.reply_held_at,
      contacts: contacts.rows.map((x) => ({ id: x.id, name: x.name, email: x.email, isPrimary: x.is_primary, hold: x.hold })),
    };
  });
}
