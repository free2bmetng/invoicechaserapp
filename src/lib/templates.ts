// Plain-text reminder templates: validation, tone presets, the mandatory footer
// and rendering. Output is plain text only. Render it as text, never as HTML.
import { DateTime } from "luxon";
import { formatMoney, normalizeCurrency } from "./money";
import { MERGE_FIELDS } from "./types";

export type TonePreset = "friendly" | "neutral" | "firm";

export interface TemplateText {
  subject: string;
  body: string;
}

export interface SenderProfile {
  senderName: string;
  businessName: string;
  postalAddress: string;
}

// Shown in previews in place of a payment link. Never sent.
export const PAY_LINK_PLACEHOLDER = "[payment link]";

export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageError";
  }
}

// Stripe is connected but no link exists. The caller marks the row failed.
export class PayLinkRequiredError extends MessageError {
  constructor(message = "Stripe is connected but no payment link is available for this message.") {
    super(message);
    this.name = "PayLinkRequiredError";
  }
}

export class SenderProfileIncompleteError extends MessageError {
  constructor(message = "Complete the sender name, business name and postal address before sending.") {
    super(message);
    this.name = "SenderProfileIncompleteError";
  }
}

export class TemplateInvalidError extends MessageError {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "TemplateInvalidError";
    this.errors = errors;
  }
}

// Written to be true whether the invoice is not yet due, due today or overdue,
// because the same preset is used at every offset. Avoid "overdue", "late",
// "past due" and "was due". Presets never mention fees, interest, legal action
// or collections; validateTemplate(..., { preset: true }) enforces that.
export const TONE_PRESETS: Record<TonePreset, TemplateText> = {
  friendly: {
    subject: "Quick note about invoice {invoice_number}",
    body: [
      "Hi {client_name},",
      "",
      "I hope you're doing well. This is a friendly note about invoice {invoice_number} for {amount}, which has a due date of {due_date}.",
      "",
      "If you've already sent payment, thank you, and you can ignore this message.",
      "",
      "You can pay online here: {pay_link}",
      "",
      "If anything about the invoice needs a second look, or you'd like to talk it through, just reply to this email. I'm happy to help.",
      "",
      "Thanks,",
      "{sender_name}",
    ].join("\n"),
  },
  neutral: {
    subject: "Invoice {invoice_number} is still open",
    body: [
      "Hello {client_name},",
      "",
      "Invoice {invoice_number} for {amount} is still open. Its due date is {due_date}.",
      "",
      "If it has already been paid, reply with the payment date and I will update my records.",
      "",
      "You can pay online here: {pay_link}",
      "",
      "If you need a copy of the invoice or have a question about it, reply to this email and I will get back to you.",
      "",
      "Kind regards,",
      "{sender_name}",
    ].join("\n"),
  },
  firm: {
    subject: "Invoice {invoice_number}: payment needed",
    body: [
      "Hello {client_name},",
      "",
      "Invoice {invoice_number} for {amount} is still open, and payment is needed. The due date on the invoice is {due_date}.",
      "",
      "Please arrange payment as soon as you can. If you have already paid, reply with the payment date so I can update my records.",
      "",
      "You can pay online here: {pay_link}",
      "",
      "If something is holding up payment, or you need to talk about the invoice, reply to this email so we can agree on next steps.",
      "",
      "Regards,",
      "{sender_name}",
    ].join("\n"),
  },
};

// Case-sensitive, word-bounded patterns. "courtesy", "interested" and "feedback"
// must not match, so the patterns avoid bare prefixes.
const PRESET_BANNED: RegExp[] = [
  /\blegal/i,
  /\b(lawyers?|solicitors?|attorneys?|courts?|lawsuits?|small claims)\b/i,
  /\bsue[ds]?\b|\bsuing\b/i,
  /\bfees?\b/i,
  /\blate (payment )?charges?\b/i,
  /\binterest\b/i,
  /\bpenalt(y|ies)\b/i,
  /\bcollections?\b/i,
  /\bdebt collect/i,
];

// Generic late-payment terms the user may copy into their own invoices. It is
// offered as an editable default and never inserted automatically. No late fee or
// interest is calculated or added.
export const LATE_PAYMENT_TERMS_SNIPPET =
  "Payment is due by the due date shown on this invoice. If you need more time or have a question about the invoice, please get in touch before that date and we will work it out together.";

const MERGE_FIELD_SET: ReadonlySet<string> = new Set<string>(MERGE_FIELDS);
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TemplateValidation = { ok: true } | { ok: false; errors: string[] };

function tokenNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) names.push(m[1]);
  return names;
}

// True when a brace is left over after every well-formed {token} is removed.
function hasStrayBrace(text: string): boolean {
  return /[{}]/.test(text.replace(/\{[^{}]*\}/g, ""));
}

// Control characters are rejected. Tab and newline are allowed only in bodies.
function hasDisallowedControl(text: string, allowWhitespace: boolean): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) continue;
    if (allowWhitespace && (code === 9 || code === 10)) continue;
    return true;
  }
  return false;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// One line of plain text: control characters become spaces, so a client name
// cannot inject a line break into a subject line.
function oneLine(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n/g, " ")) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.trim();
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function isSenderProfileComplete(sender: Partial<SenderProfile> | null | undefined): boolean {
  return !!sender && filled(sender.senderName) && filled(sender.businessName) && filled(sender.postalAddress);
}

function assertSenderComplete(sender: SenderProfile): void {
  if (!isSenderProfileComplete(sender)) throw new SenderProfileIncompleteError();
}

export function validateTemplate(input: TemplateText, opts: { preset?: boolean } = {}): TemplateValidation {
  const errors: string[] = [];
  const subject = typeof input?.subject === "string" ? input.subject : "";
  const body = typeof input?.body === "string" ? normalizeLineEndings(input.body) : "";

  if (subject.trim() === "") errors.push("The subject is required.");
  if (hasDisallowedControl(subject, false)) errors.push("The subject must be a single line of plain text.");
  if (body.trim() === "") errors.push("The message body is required.");
  if (hasDisallowedControl(body, true)) errors.push("The message body contains a control character.");

  for (const [field, text] of [
    ["subject", subject],
    ["body", body],
  ] as const) {
    for (const name of new Set(tokenNames(text))) {
      if (!MERGE_FIELD_SET.has(name)) {
        const allowed = MERGE_FIELDS.map((f) => `{${f}}`).join(", ");
        errors.push(`Unknown field {${name}} in the ${field}. Use only ${allowed}.`);
      }
    }
    if (hasStrayBrace(text)) {
      errors.push(`The ${field} has a { or } that is not part of a field. Remove it or use a listed field.`);
    }
  }

  if (tokenNames(subject).includes("pay_link")) errors.push("{pay_link} can only be used in the message body.");

  if (opts.preset) {
    for (const [field, text] of [
      ["subject", subject],
      ["body", body],
    ] as const) {
      const found = new Set<string>();
      for (const pattern of PRESET_BANNED) {
        const match = pattern.exec(text);
        if (match) found.add(match[0].toLowerCase());
      }
      for (const word of found) {
        errors.push(`The ${field} uses "${word}", which is not allowed in a preset. Presets never mention fees, interest, legal action or collections.`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// The footer every client-facing message ends with. Users cannot remove it.
// Returns the separator line, the sender line and one line per address line.
export function FOOTER_LINES(sender: SenderProfile): string {
  assertSenderComplete(sender);
  const addressLines = sender.postalAddress
    .split(/\r\n|\r|\n/)
    .map((line) => oneLine(line))
    .filter((line) => line !== "");
  return ["---", `${oneLine(sender.senderName)}, ${oneLine(sender.businessName)}`, ...addressLines].join("\n");
}

function assertTimezone(timezone: string): void {
  if (typeof timezone !== "string" || !DateTime.local().setZone(timezone).isValid) {
    throw new MessageError(`Unknown timezone "${timezone}".`);
  }
}

// "8 Nov 2026". A YYYY-MM-DD string is a calendar date and is shown as written.
// A Date is an instant and is shown as its date in the client's timezone.
function formatDueDate(dueDate: Date | string, timezone: string): string {
  assertTimezone(timezone);
  let dt: DateTime;
  if (typeof dueDate === "string") {
    dt = CALENDAR_DATE.test(dueDate)
      ? DateTime.fromISO(dueDate, { zone: "utc" })
      : DateTime.fromISO(dueDate, { zone: timezone });
  } else if (dueDate instanceof Date) {
    dt = DateTime.fromJSDate(dueDate, { zone: timezone });
  } else {
    throw new MessageError("The due date must be a Date or a YYYY-MM-DD string.");
  }
  if (!dt.isValid) throw new MessageError(`The due date "${String(dueDate)}" is not a valid date.`);
  return dt.setLocale("en").toFormat("d LLL yyyy");
}

function daysOverdueValue(days: number): string {
  if (!Number.isFinite(days)) throw new MessageError("Days overdue must be a number.");
  return String(Math.max(0, Math.trunc(days)));
}

// Accepts only http(s) URLs with no whitespace.
function assertPayLink(url: string): void {
  let valid = typeof url === "string" && url.length > 0 && !/\s/.test(url);
  if (valid) {
    try {
      const parsed = new URL(url);
      valid = (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "";
    } catch {
      valid = false;
    }
  }
  if (!valid) throw new MessageError("The payment link must be a plain http or https URL.");
}

// Replaces each {field} in one pass, so a value that itself contains "{amount}"
// is not replaced again.
function replaceTokens(text: string, values: Record<string, string>, link: string | null): string {
  return text.replace(/\{([^{}]*)\}/g, (match: string, name: string) => {
    if (name === "pay_link") return link ?? "";
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match;
  });
}

export interface BuildMessageArgs {
  template: TemplateText;
  context: {
    clientName: string;
    invoiceNumber: string;
    amountMinor: number;
    currency: string;
    dueDate: Date | string;
    daysOverdue: number;
    senderName: string;
    businessName: string;
    timezone: string;
    payLink: string | null;
  };
  stripeConnected: boolean;
  sender: SenderProfile;
  // Preview only. {pay_link} shows as PAY_LINK_PLACEHOLDER, no link is needed, and
  // nothing throws for a missing link. Never set this when a message is sent.
  preview?: boolean;
}

// Builds the subject and plain-text body for one message, footer included.
export function buildMessage(args: BuildMessageArgs): { subject: string; text: string } {
  const { template, context, stripeConnected, sender } = args;

  assertSenderComplete(sender);
  if (
    (context.senderName ?? "").trim() !== sender.senderName.trim() ||
    (context.businessName ?? "").trim() !== sender.businessName.trim()
  ) {
    throw new MessageError("The sender name and business name in the message context must match the sender profile.");
  }

  let link: string | null;
  if (args.preview) {
    link = PAY_LINK_PLACEHOLDER;
  } else if (context.payLink === null || context.payLink === undefined) {
    if (stripeConnected) throw new PayLinkRequiredError();
    link = null;
  } else {
    assertPayLink(context.payLink);
    link = context.payLink;
  }

  const check = validateTemplate(template);
  if (!check.ok) throw new TemplateInvalidError(check.errors);

  const values: Record<string, string> = {
    client_name: oneLine(context.clientName ?? ""),
    invoice_number: oneLine(context.invoiceNumber ?? ""),
    amount: formatMoney(context.amountMinor, context.currency),
    currency: normalizeCurrency(context.currency),
    due_date: formatDueDate(context.dueDate, context.timezone),
    days_overdue: daysOverdueValue(context.daysOverdue),
    sender_name: oneLine(sender.senderName),
    business_name: oneLine(sender.businessName),
  };
  if (values.client_name === "") throw new MessageError("The client name is required.");
  if (values.invoice_number === "") throw new MessageError("The invoice number is required.");

  const subject = replaceTokens(template.subject, values, null).trim();
  if (subject === "") throw new MessageError("The subject is empty after filling in the fields.");

  const body = normalizeLineEndings(template.body);
  const hasPayToken = body.includes("{pay_link}");

  // With no link, drop every line that mentions {pay_link}. Then fill fields.
  const keptLines = link === null ? body.split("\n").filter((line) => !line.includes("{pay_link}")) : body.split("\n");
  let message = replaceTokens(keptLines.join("\n"), values, link);
  if (link !== null && !hasPayToken) message = `${message.trimEnd()}\n\nPay online: ${link}`;
  message = message.replace(/\n{3,}/g, "\n\n").trim();
  if (message === "") throw new MessageError("The message body is empty after filling in the fields.");

  return { subject, text: `${message}\n\n${FOOTER_LINES(sender)}` };
}
