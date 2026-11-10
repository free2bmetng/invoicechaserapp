// Read helpers for the sequence screens: usage counts, the invoices a preview can use, and the
// live preview. The preview renders with buildMessage in preview mode. It never reads or creates a
// payment link, never calls a provider, and never writes a row.
import { withUser } from "@/lib/db";
import { buildMessage, MessageError, TONE_PRESETS, validateTemplate, type TonePreset } from "@/lib/templates";
import { loadWorkspace, zoneOrUtc } from "./invoices";
import { dueDateLabel } from "@/components/invoices/format";

export type SequenceKind = "standard" | "plan";

// The open invoices that use each sequence, following the precedence in engine/store.ts: invoice
// override, then client, then the default. Plan sequences: payment plan invoices use the default.
export interface SequenceUser {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  dueDate: string;
  amountMinor: number;
  currency: string;
  status: "open" | "payment_plan";
}

export async function sequenceUsers(userId: string): Promise<Map<string, SequenceUser[]>> {
  return withUser(userId, async (c) => {
    const seqs = await c.query<{ id: string; kind: SequenceKind; is_default: boolean }>(
      "select id, kind, is_default from sequences where user_id = $1",
      [userId],
    );
    const standard = new Set(seqs.rows.filter((s) => s.kind === "standard").map((s) => s.id));
    const defaultStandard = seqs.rows.find((s) => s.kind === "standard" && s.is_default)?.id ?? null;
    const defaultPlan = seqs.rows.find((s) => s.kind === "plan" && s.is_default)?.id ?? null;

    const invoices = await c.query<{
      id: string; invoice_number: string; client_name: string; due_date: string; amount: string; currency: string;
      sequence_id: string | null; client_sequence_id: string | null; status: "open" | "payment_plan";
    }>(
      `select i.id, i.invoice_number, cl.name as client_name, i.due_date::text as due_date, i.amount_minor::text as amount,
         i.currency, i.sequence_id, cl.sequence_id as client_sequence_id, i.status
       from invoices i join clients cl on cl.id = i.client_id and cl.user_id = i.user_id
       where i.user_id = $1 and i.status in ('open', 'payment_plan')
       order by i.due_date, i.invoice_number`,
      [userId],
    );
    const users = new Map<string, SequenceUser[]>();
    for (const inv of invoices.rows) {
      const effective = inv.status === "payment_plan"
        ? defaultPlan
        : ([inv.sequence_id, inv.client_sequence_id].find((id): id is string => id !== null && standard.has(id)) ?? defaultStandard);
      if (!effective) continue;
      const list = users.get(effective) ?? [];
      list.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: inv.client_name,
        dueDate: inv.due_date,
        amountMinor: Number(inv.amount),
        currency: inv.currency,
        status: inv.status,
      });
      users.set(effective, list);
    }
    return users;
  });
}

// How many open invoices use each sequence (see sequenceUsers).
export async function sequenceUsage(userId: string): Promise<Map<string, number>> {
  const users = await sequenceUsers(userId);
  return new Map([...users].map(([id, list]) => [id, list.length]));
}

// Who a reminder comes from, and when reminders may send. Shown on the sequence screens.
export interface SendingProfile {
  fromName: string;
  fromAddress: string | null;
  windowStart: number;
  windowEnd: number;
}

export async function sendingProfile(userId: string): Promise<SendingProfile> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ sender_name: string; business_name: string; sending_domain: string | null; send_window_start: number; send_window_end: number }>(
      "select sender_name, business_name, sending_domain, send_window_start, send_window_end from settings where user_id = $1",
      [userId],
    );
    const r = rows[0];
    const name = [r?.sender_name?.trim(), r?.business_name?.trim()].filter(Boolean).join(", ");
    return {
      fromName: name || "Your name",
      fromAddress: r?.sending_domain ? `invoices@${r.sending_domain}` : null,
      windowStart: r?.send_window_start ?? 9,
      windowEnd: r?.send_window_end ?? 17,
    };
  });
}

export interface PayableChoice {
  value: string;
  label: string;
}

// The invoices (standard sequences) or installments (plan sequences) a preview can render against.
export async function previewChoices(userId: string, kind: SequenceKind): Promise<PayableChoice[]> {
  return withUser(userId, async (c) => {
    if (kind === "standard") {
      const { rows } = await c.query<{ id: string; invoice_number: string; client_name: string; due_date: string }>(
        `select i.id, i.invoice_number, cl.name as client_name, i.due_date::text as due_date
         from invoices i join clients cl on cl.id = i.client_id
         where i.user_id = $1 order by i.created_at desc limit 200`,
        [userId],
      );
      return rows.map((r) => ({ value: r.id, label: `${r.invoice_number} · ${r.client_name} · due ${dueDateLabel(r.due_date)}` }));
    }
    const { rows } = await c.query<{ id: string; invoice_number: string; client_name: string; position: number; due_date: string }>(
      `select p.id, i.invoice_number, cl.name as client_name, p.position, p.due_date::text as due_date
       from payment_plan_installments p
         join invoices i on i.id = p.invoice_id and i.user_id = p.user_id
         join clients cl on cl.id = i.client_id
       where p.user_id = $1 and i.status = 'payment_plan' and p.status = 'open'
       order by i.invoice_number, p.position limit 200`,
      [userId],
    );
    return rows.map((r) => ({
      value: r.id,
      label: `${r.invoice_number} · ${r.client_name} · installment ${r.position}, due ${dueDateLabel(r.due_date)}`,
    }));
  });
}

export type PreviewOutcome =
  | {
      ok: true;
      subject: string;
      text: string;
      // True when the sender profile is incomplete and bracketed placeholders stand in for it.
      placeholderSender: boolean;
      stripeConnected: boolean;
      payableLabel: string;
      // The envelope, for the email-client frame around the preview.
      to: string;
      from: string;
    }
  | { ok: false; errors: string[] };

export interface PreviewArgs {
  userId: string;
  kind: SequenceKind;
  payableId: string;
  tone: string;
  subject: string;
  body: string;
  offsetDays: number;
}

// Renders one step against one real payable. Presets always render their own text, never the
// draft, so a preset cannot be previewed with edited wording.
export async function renderStepPreview(args: PreviewArgs): Promise<PreviewOutcome> {
  const { userId, kind, payableId, tone, offsetDays } = args;
  const isPreset = tone === "friendly" || tone === "neutral" || tone === "firm";
  const template = isPreset ? TONE_PRESETS[tone as TonePreset] : { subject: args.subject, body: args.body };

  const check = validateTemplate(template, { preset: isPreset });
  if (!check.ok) return { ok: false, errors: check.errors };

  const payable = await loadPayable(userId, kind, payableId);
  if (!payable) return { ok: false, errors: ["That invoice could not be found. Choose another to preview with."] };

  const workspace = await loadWorkspace(userId);
  const complete = workspace.profileComplete;
  const sender = complete
    ? workspace.sender
    : {
        senderName: workspace.sender.senderName.trim() || "[Your name]",
        businessName: workspace.sender.businessName.trim() || "[Business name]",
        postalAddress: workspace.sender.postalAddress.trim() || "[Postal address]",
      };

  try {
    const built = buildMessage({
      template,
      context: {
        clientName: payable.clientName,
        invoiceNumber: payable.invoiceNumber,
        amountMinor: payable.amountMinor,
        currency: payable.currency,
        dueDate: payable.dueDate,
        // Mirrors the sender: zero for steps planned on or before the due date.
        daysOverdue: Math.max(0, offsetDays),
        senderName: sender.senderName,
        businessName: sender.businessName,
        timezone: zoneOrUtc(payable.clientTimezone) || workspace.zone,
        payLink: null,
      },
      stripeConnected: workspace.stripeConnected,
      sender,
      // Mirror the sender. With Stripe connected, {pay_link} shows as a placeholder. Without it, the
      // sender removes those lines, so the preview does the same and never shows a link.
      preview: workspace.stripeConnected,
    });
    return {
      ok: true,
      subject: built.subject,
      text: built.text,
      placeholderSender: !complete,
      stripeConnected: workspace.stripeConnected,
      payableLabel: payable.label,
      to: payable.clientEmail,
      from: [sender.senderName, sender.businessName].filter((v) => v.trim() !== "").join(", "),
    };
  } catch (err) {
    if (err instanceof MessageError) return { ok: false, errors: [err.message] };
    throw err;
  }
}

interface PayableRow {
  clientName: string;
  clientEmail: string;
  clientTimezone: string | null;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  label: string;
}

async function loadPayable(userId: string, kind: SequenceKind, payableId: string): Promise<PayableRow | null> {
  return withUser(userId, async (c) => {
    if (kind === "standard") {
      const { rows } = await c.query<{
        invoice_number: string; amount: string; currency: string; due_date: string; client_name: string; client_email: string; client_timezone: string | null;
      }>(
        `select i.invoice_number, i.amount_minor::text as amount, i.currency, i.due_date::text as due_date,
           cl.name as client_name, cl.email as client_email, cl.timezone as client_timezone
         from invoices i join clients cl on cl.id = i.client_id
         where i.id = $1 and i.user_id = $2`,
        [payableId, userId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        clientName: r.client_name,
        clientEmail: r.client_email,
        clientTimezone: r.client_timezone,
        invoiceNumber: r.invoice_number,
        amountMinor: Number(r.amount),
        currency: r.currency,
        dueDate: r.due_date,
        label: `${r.invoice_number} · ${r.client_name}`,
      };
    }
    const { rows } = await c.query<{
      invoice_number: string; position: number; amount: string; currency: string; due_date: string; client_name: string; client_email: string; client_timezone: string | null;
    }>(
      `select i.invoice_number, p.position, p.amount_minor::text as amount, p.currency, p.due_date::text as due_date,
         cl.name as client_name, cl.email as client_email, cl.timezone as client_timezone
       from payment_plan_installments p
         join invoices i on i.id = p.invoice_id and i.user_id = p.user_id
         join clients cl on cl.id = i.client_id
       where p.id = $1 and p.user_id = $2`,
      [payableId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      clientName: r.client_name,
      clientEmail: r.client_email,
      clientTimezone: r.client_timezone,
      invoiceNumber: r.invoice_number,
      amountMinor: Number(r.amount),
      currency: r.currency,
      dueDate: r.due_date,
      label: `${r.invoice_number} · installment ${r.position}`,
    };
  });
}
