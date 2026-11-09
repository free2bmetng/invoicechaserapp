// One render path for every message the app shows or sends. The sender and the read
// screens (invoice timeline, Next 7 days) call the same functions, so they cannot disagree.
//
// Sending uses buildMessage with the real payment link. Previews never create a link:
// a reusable stored link is shown, a Stripe account with no link shows the placeholder,
// and no Stripe account drops the pay-link line, as the sender does.
import type { PoolClient } from "pg";
import { buildMessage, FOOTER_LINES, type BuildMessageArgs } from "@/lib/templates";
import { reusableLinkUrl } from "./payments";
import { settingsProfileComplete } from "./profile";
import * as S from "./store";
import { NotFoundError } from "./errors";

export interface RenderInput {
  settings: S.SettingsRow;
  client: S.ClientRow;
  invoice: S.InvoiceRow;
  // The invoice itself, or its installment for a payment plan row.
  payable: S.InvoiceRow | S.InstallmentRow;
  step: S.StepRow;
  message: Pick<S.MessageRow, "subject_override" | "body_override">;
}

// How a rendered message was produced, for the screens that show it.
export interface RenderNote {
  // False when the sender profile is incomplete. The footer is then left out.
  footerIncluded: boolean;
  profileComplete: boolean;
  paymentLink: "included" | "placeholder" | "omitted";
  renderError: string | null;
}

export interface PreviewRender extends RenderNote {
  subject: string | null;
  body: string | null;
}

const PLACEHOLDER = {
  senderName: "[sender name]",
  businessName: "[business name]",
  postalAddress: "[postal address]",
};

function zoneOf(i: RenderInput): string {
  return i.client.timezone || i.settings.timezone;
}

function templateOf(i: RenderInput): { subject: string; body: string } {
  return {
    subject: i.message.subject_override ?? i.step.subject,
    body: i.message.body_override ?? i.step.body,
  };
}

function fieldsOf(i: RenderInput) {
  return {
    clientName: i.client.name,
    invoiceNumber: i.invoice.invoice_number,
    amountMinor: i.payable.amount_minor,
    currency: i.payable.currency,
    dueDate: i.payable.due_date,
    // Clamped to 0 for steps planned on or before the due date (content rule).
    daysOverdue: Math.max(0, i.step.offset_days),
    timezone: zoneOf(i),
  };
}

export function senderOf(settings: S.SettingsRow): { senderName: string; businessName: string; postalAddress: string } {
  return {
    senderName: settings.sender_name.trim(),
    businessName: settings.business_name.trim(),
    postalAddress: settings.postal_address.trim(),
  };
}

// The message the client will receive. Throws MessageError (and subclasses) when it cannot be built.
export function renderForSend(
  i: RenderInput & { payLink: string | null; stripeConnected: boolean },
): { subject: string; text: string } {
  const sender = senderOf(i.settings);
  const args: BuildMessageArgs = {
    template: templateOf(i),
    context: {
      ...fieldsOf(i),
      senderName: sender.senderName,
      businessName: sender.businessName,
      payLink: i.payLink,
    },
    stripeConnected: i.stripeConnected,
    sender,
  };
  return buildMessage(args);
}

// The message as it would be sent, for display. Never creates a payment link.
export function renderForPreview(
  i: RenderInput & { stripeConnected: boolean; storedLinkUrl: string | null },
): PreviewRender {
  const profileComplete = settingsProfileComplete(i.settings);
  const sender = {
    senderName: i.settings.sender_name.trim() || PLACEHOLDER.senderName,
    businessName: i.settings.business_name.trim() || PLACEHOLDER.businessName,
    postalAddress: i.settings.postal_address.trim() || PLACEHOLDER.postalAddress,
  };
  const context = {
    ...fieldsOf(i),
    senderName: sender.senderName,
    businessName: sender.businessName,
  };
  try {
    let out: { subject: string; text: string };
    let paymentLink: PreviewRender["paymentLink"];
    if (i.stripeConnected && i.storedLinkUrl) {
      out = buildMessage({ template: templateOf(i), context: { ...context, payLink: i.storedLinkUrl }, stripeConnected: true, sender });
      paymentLink = "included";
    } else if (i.stripeConnected) {
      // The link is created at send time. Show the placeholder until then.
      out = buildMessage({ template: templateOf(i), context: { ...context, payLink: null }, stripeConnected: true, sender, preview: true });
      paymentLink = "placeholder";
    } else {
      out = buildMessage({ template: templateOf(i), context: { ...context, payLink: null }, stripeConnected: false, sender });
      paymentLink = "omitted";
    }
    let body = out.text;
    if (!profileComplete) {
      // Merge fields are filled with placeholders where the profile is blank. The footer is removed.
      const suffix = `\n\n${FOOTER_LINES(sender)}`;
      if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
    }
    return {
      subject: out.subject,
      body,
      footerIncluded: profileComplete,
      profileComplete,
      paymentLink,
      renderError: null,
    };
  } catch (err) {
    return {
      subject: null,
      body: null,
      footerIncluded: false,
      profileComplete,
      paymentLink: "omitted",
      renderError: err instanceof Error ? err.message : "The message could not be rendered.",
    };
  }
}

export interface RowParts {
  invoice: S.InvoiceRow;
  client: S.ClientRow;
  installment: S.InstallmentRow | null;
  step: S.StepRow | null;
}

export async function loadRowParts(c: PoolClient, userId: string, row: S.MessageRow): Promise<RowParts> {
  const invoice = await S.loadInvoice(c, userId, row.invoice_id);
  const client = await S.loadClient(c, userId, invoice.client_id);
  const installment = row.installment_id ? await S.loadInstallment(c, userId, row.installment_id) : null;
  const step = row.step_id ? await S.loadStep(c, userId, row.step_id) : null;
  return { invoice, client, installment, step };
}

// Preview of one unsent row. The settings and the Stripe flag are passed in so that a
// list of rows reads them once.
export async function previewRow(
  c: PoolClient,
  userId: string,
  row: S.MessageRow,
  shared: { settings: S.SettingsRow; stripeConnected: boolean },
): Promise<PreviewRender> {
  const parts = await loadRowParts(c, userId, row);
  if (!parts.step) {
    return {
      subject: null,
      body: null,
      footerIncluded: false,
      profileComplete: settingsProfileComplete(shared.settings),
      paymentLink: "omitted",
      renderError: "This message's step was removed.",
    };
  }
  const payable = parts.installment ?? parts.invoice;
  return renderForPreview({
    settings: shared.settings,
    client: parts.client,
    invoice: parts.invoice,
    payable,
    step: parts.step,
    message: row,
    stripeConnected: shared.stripeConnected,
    storedLinkUrl: reusableLinkUrl(payable),
  });
}

// The text a needs_check message was attempted with, recorded before the provider call.
export async function attemptedText(
  c: PoolClient,
  userId: string,
  messageId: string,
): Promise<{ subject: string; body: string } | null> {
  const { rows } = await c.query<{ detail: { subject?: string; body_snapshot?: string } }>(
    `select detail from events where user_id = $1 and type = 'send_attempt'
       and detail->>'scheduled_message_id' = $2 order by id desc limit 1`,
    [userId, messageId],
  );
  const detail = rows[0]?.detail;
  if (!detail || typeof detail.body_snapshot !== "string") return null;
  return { subject: String(detail.subject ?? ""), body: detail.body_snapshot };
}

export { NotFoundError };
