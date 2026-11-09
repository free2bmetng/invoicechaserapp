// Read helpers for the sequence screens: usage counts, the invoices a preview can use, and the
// live preview. The preview renders with buildMessage in preview mode. It never reads or creates a
// payment link, never calls a provider, and never writes a row.
import { withUser } from "@/lib/db";
import { buildMessage, MessageError, TONE_PRESETS, validateTemplate, type TonePreset } from "@/lib/templates";
import { loadWorkspace, zoneOrUtc } from "./invoices";
import { dueDateLabel } from "@/components/invoices/format";

export type SequenceKind = "standard" | "plan";

// How many open invoices use each standard sequence, following the precedence in engine/store.ts:
// invoice override, then client, then the default. Plan sequences: payment plan invoices use the default.
export async function sequenceUsage(userId: string): Promise<Map<string, number>> {
  return withUser(userId, async (c) => {
    const seqs = await c.query<{ id: string; kind: SequenceKind; is_default: boolean }>(
      "select id, kind, is_default from sequences where user_id = $1",
      [userId],
    );
    const standard = new Set(seqs.rows.filter((s) => s.kind === "standard").map((s) => s.id));
    const defaultStandard = seqs.rows.find((s) => s.kind === "standard" && s.is_default)?.id ?? null;
    const defaultPlan = seqs.rows.find((s) => s.kind === "plan" && s.is_default)?.id ?? null;

    const clients = await c.query<{ id: string; sequence_id: string | null }>(
      "select id, sequence_id from clients where user_id = $1",
      [userId],
    );
    const clientSeq = new Map(clients.rows.map((r) => [r.id, r.sequence_id]));

    const invoices = await c.query<{ client_id: string; sequence_id: string | null; status: string }>(
      "select client_id, sequence_id, status from invoices where user_id = $1 and status in ('open', 'payment_plan')",
      [userId],
    );
    const counts = new Map<string, number>();
    for (const inv of invoices.rows) {
      if (inv.status === "payment_plan") {
        if (defaultPlan) counts.set(defaultPlan, (counts.get(defaultPlan) ?? 0) + 1);
        continue;
      }
      const candidates = [inv.sequence_id, clientSeq.get(inv.client_id) ?? null];
      const effective = candidates.find((id): id is string => id !== null && standard.has(id)) ?? defaultStandard;
      if (effective) counts.set(effective, (counts.get(effective) ?? 0) + 1);
    }
    return counts;
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
    };
  } catch (err) {
    if (err instanceof MessageError) return { ok: false, errors: [err.message] };
    throw err;
  }
}

interface PayableRow {
  clientName: string;
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
        invoice_number: string; amount: string; currency: string; due_date: string; client_name: string; client_timezone: string | null;
      }>(
        `select i.invoice_number, i.amount_minor::text as amount, i.currency, i.due_date::text as due_date,
           cl.name as client_name, cl.timezone as client_timezone
         from invoices i join clients cl on cl.id = i.client_id
         where i.id = $1 and i.user_id = $2`,
        [payableId, userId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        clientName: r.client_name,
        clientTimezone: r.client_timezone,
        invoiceNumber: r.invoice_number,
        amountMinor: Number(r.amount),
        currency: r.currency,
        dueDate: r.due_date,
        label: `${r.invoice_number} · ${r.client_name}`,
      };
    }
    const { rows } = await c.query<{
      invoice_number: string; position: number; amount: string; currency: string; due_date: string; client_name: string; client_timezone: string | null;
    }>(
      `select i.invoice_number, p.position, p.amount_minor::text as amount, p.currency, p.due_date::text as due_date,
         cl.name as client_name, cl.timezone as client_timezone
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
      clientTimezone: r.client_timezone,
      invoiceNumber: r.invoice_number,
      amountMinor: Number(r.amount),
      currency: r.currency,
      dueDate: r.due_date,
      label: `${r.invoice_number} · installment ${r.position}`,
    };
  });
}
