// Derived views over row states. There is no separate queue table (spec 3.6).
import { DateTime } from "luxon";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import * as S from "./store";
import type { MessageRow } from "./store";
import { loadRowParts, previewRow, type RenderNote } from "./render";
import { startOfLocalDay } from "./window";

export type NeedsYouKind = "approval" | "bounce" | "reply" | "failed" | "needs_check" | "disputed" | "paid_while_disputed";

export interface NeedsYouItem {
  kind: NeedsYouKind;
  key: string;
  title: string;
  detail: string;
  messageId: string | null;
  invoiceId: string | null;
  clientId: string | null;
  contactId: string | null;
  plannedAt: Date | null;
}

// Step wording matches the schedule (src/components/invoices/format.ts, describeOffset):
// "3 days before the due date", "on the due date", "7 days after the due date".
function approvalTitle(invoiceNumber: string, offsetDays: number | null, installment: boolean): string {
  if (offsetDays === null) return `Reminder ${invoiceNumber} needs approval`;
  const anchor = installment ? "the installment due date" : "the due date";
  if (offsetDays === 0) return `Reminder ${invoiceNumber}: on ${anchor}`;
  const n = Math.abs(offsetDays);
  const days = `${n} ${n === 1 ? "day" : "days"}`;
  return `Reminder ${invoiceNumber}: ${days} ${offsetDays < 0 ? "before" : "after"} ${anchor}`;
}

// The Needs you queue. Its count is the in-app badge.
export async function listNeedsYou(userId: string): Promise<NeedsYouItem[]> {
  return withUser(userId, async (c) => {
    const items: NeedsYouItem[] = [];

    const approvals = await c.query<{
      id: string; planned_at: Date; invoice_id: string; invoice_number: string; client_id: string; client_name: string;
      installment_id: string | null; offset_days: number | null;
    }>(
      `select m.id, m.planned_at, m.invoice_id, m.installment_id, i.invoice_number, cl.id as client_id, cl.name as client_name,
         st.offset_days
       from scheduled_messages m join invoices i on i.id = m.invoice_id join clients cl on cl.id = i.client_id
         left join sequence_steps st on st.id = m.step_id
       where m.user_id = $1 and m.status = 'pending_approval' order by m.planned_at, m.id`,
      [userId],
    );
    for (const r of approvals.rows) {
      items.push({
        kind: "approval",
        key: `approval:${r.id}`,
        title: approvalTitle(r.invoice_number, r.offset_days, r.installment_id !== null),
        detail: `${r.client_name}. Waiting for your approval before it is sent.`,
        messageId: r.id,
        invoiceId: r.invoice_id,
        clientId: r.client_id,
        contactId: null,
        plannedAt: r.planned_at,
      });
    }

    const bounces = await c.query<{ id: string; email: string; client_id: string; client_name: string }>(
      `select ct.id, ct.email, cl.id as client_id, cl.name as client_name
       from contacts ct join clients cl on cl.id = ct.client_id
       where ct.user_id = $1 and ct.hold = 'bounced' order by ct.email`,
      [userId],
    );
    for (const r of bounces.rows) {
      items.push({
        kind: "bounce",
        key: `bounce:${r.id}`,
        title: `${r.email} bounced for ${r.client_name}`,
        detail: "Nothing more goes to this address until you change the contact and resume it.",
        messageId: null,
        invoiceId: null,
        clientId: r.client_id,
        contactId: r.id,
        plannedAt: null,
      });
    }

    const replies = await c.query<{ id: string; name: string; n: string }>(
      `select cl.id, cl.name, count(m.id)::text as n
       from clients cl join invoices i on i.client_id = cl.id
         join scheduled_messages m on m.invoice_id = i.id
       where cl.user_id = $1 and cl.reply_held_at is not null and m.status = 'held'
       group by cl.id, cl.name order by cl.name`,
      [userId],
    );
    for (const r of replies.rows) {
      items.push({
        kind: "reply",
        key: `reply:${r.id}`,
        title: `${r.name} replied`,
        detail: `${r.n} held message(s) wait for you to resume or cancel them.`,
        messageId: null,
        invoiceId: null,
        clientId: r.id,
        contactId: null,
        plannedAt: null,
      });
    }

    for (const status of ["failed", "needs_check"] as const) {
      const rows = await c.query<{ id: string; planned_at: Date; invoice_id: string; invoice_number: string; client_name: string; client_id: string }>(
        `select m.id, m.planned_at, m.invoice_id, i.invoice_number, cl.id as client_id, cl.name as client_name
         from scheduled_messages m join invoices i on i.id = m.invoice_id join clients cl on cl.id = i.client_id
         where m.user_id = $1 and m.status = $2 order by m.planned_at, m.id`,
        [userId, status],
      );
      for (const r of rows.rows) {
        items.push({
          kind: status === "failed" ? "failed" : "needs_check",
          key: `${status}:${r.id}`,
          title:
            status === "failed"
              ? `Reminder ${r.invoice_number} for ${r.client_name} failed to send`
              : `Check whether the reminder ${r.invoice_number} for ${r.client_name} was delivered`,
          detail:
            status === "failed"
              ? "The provider refused it before accepting it. Retry or cancel."
              : "The send may have happened. Mark it as sent or dismiss it. It is never resent automatically.",
          messageId: r.id,
          invoiceId: r.invoice_id,
          clientId: r.client_id,
          contactId: null,
          plannedAt: r.planned_at,
        });
      }
    }

    const disputed = await c.query<{ id: string; invoice_number: string; client_id: string; client_name: string }>(
      `select i.id, i.invoice_number, cl.id as client_id, cl.name as client_name
       from invoices i join clients cl on cl.id = i.client_id
       where i.user_id = $1 and i.status = 'disputed' order by i.invoice_number`,
      [userId],
    );
    for (const r of disputed.rows) {
      items.push({
        kind: "disputed",
        key: `disputed:${r.id}`,
        title: `Invoice ${r.invoice_number} for ${r.client_name} is disputed`,
        detail: "Reminders are stopped for this invoice until its status changes.",
        messageId: null,
        invoiceId: r.id,
        clientId: r.client_id,
        contactId: null,
        plannedAt: null,
      });
    }
    // A payment that arrived while the invoice was disputed or written off. It stays until acknowledged.
    const paidWhileDisputed = await c.query<{ id: string; invoice_number: string; client_id: string; client_name: string; prior_status: string | null }>(
      `select i.id, i.invoice_number, cl.id as client_id, cl.name as client_name, e.detail->>'prior_status' as prior_status
       from invoices i
         join clients cl on cl.id = i.client_id
         join lateral (
           select id, detail from events
            where user_id = $1 and invoice_id = i.id and type = 'paid_while_disputed'
            order by id desc limit 1
         ) e on true
       where i.user_id = $1
         and not exists (
           select 1 from events a where a.user_id = $1 and a.invoice_id = i.id
             and a.type = 'paid_while_disputed_acknowledged' and a.id > e.id
         )
       order by i.invoice_number`,
      [userId],
    );
    for (const r of paidWhileDisputed.rows) {
      const was = r.prior_status === "written_off" ? "written off" : "disputed";
      items.push({
        kind: "paid_while_disputed",
        key: `paid_while_disputed:${r.id}`,
        title: "Paid while disputed. Check the dispute is resolved.",
        detail: `Invoice ${r.invoice_number} for ${r.client_name} was ${was} when the payment arrived.`,
        messageId: null,
        invoiceId: r.id,
        clientId: r.client_id,
        contactId: null,
        plannedAt: null,
      });
    }
    return items;
  });
}

export interface UpcomingMessage {
  messageId: string;
  status: string;
  plannedAt: Date;
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  contactEmail: string;
  amountMinor: number;
  currency: string;
  requiresApproval: boolean;
  // The text the client will receive, rendered by the same path the sender uses.
  subject: string | null;
  body: string | null;
  render: RenderNote;
}

// Messages planned for the user's next 7 local days (today included). Only unsent rows,
// and each one rendered the same way the invoice timeline renders it.
export async function listNextSevenDays(userId: string, clock: Clock): Promise<UpcomingMessage[]> {
  return withUser(userId, async (c) => {
    const settings = await S.loadSettings(c, userId);
    const stripe = await S.stripeConnected(c, userId);
    const now = clock.now();
    const start = startOfLocalDay(now, settings.timezone);
    const end = DateTime.fromJSDate(start, { zone: settings.timezone }).plus({ days: 7 }).toJSDate();
    const { rows } = await c.query<MessageRow>(
      `${S.MESSAGE_SELECT} where user_id = $1 and status in ('pending_approval', 'scheduled', 'held')
         and planned_at >= $2 and planned_at < $3 order by planned_at, id`,
      [userId, start, end],
    );
    const out: UpcomingMessage[] = [];
    for (const m of rows) {
      const parts = await loadRowParts(c, userId, m);
      const contact = await S.loadContact(c, userId, m.contact_id);
      const payable = parts.installment ?? parts.invoice;
      const preview = await previewRow(c, userId, m, { settings, stripeConnected: stripe });
      out.push({
        messageId: m.id,
        status: m.status,
        plannedAt: m.planned_at,
        invoiceId: parts.invoice.id,
        invoiceNumber: parts.invoice.invoice_number,
        clientName: parts.client.name,
        contactEmail: contact?.email ?? "",
        amountMinor: payable.amount_minor,
        currency: payable.currency,
        requiresApproval: m.requires_approval,
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
    return out;
  });
}
