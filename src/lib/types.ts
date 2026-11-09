// Shared domain vocabulary. Keep these in sync with db/migrations/0001_init.sql.

export const INVOICE_STATUSES = [
  "open",
  "paid",
  "paused",
  "disputed",
  "payment_plan",
  "written_off",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// Only these statuses can produce client-facing messages.
export const MESSAGE_GENERATING_INVOICE_STATUSES: readonly InvoiceStatus[] = ["open", "payment_plan"];

export const MESSAGE_STATUSES = [
  "pending_approval",
  "scheduled",
  "held",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "needs_check",
  "cancelled",
  "skipped",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// Rows the user or the planner can still change. Never dispatched.
export const UNSENT_STATUSES: readonly MessageStatus[] = ["pending_approval", "scheduled", "held"];

// Rows where the provider was called, or may have been. Never return to unsent.
export const DISPATCHED_STATUSES: readonly MessageStatus[] = ["sent", "delivered", "bounced", "needs_check"];

export const TONES = ["friendly", "neutral", "firm", "custom"] as const;
export type Tone = (typeof TONES)[number];

export const MERGE_FIELDS = [
  "client_name",
  "invoice_number",
  "amount",
  "currency",
  "due_date",
  "days_overdue",
  "pay_link",
  "sender_name",
  "business_name",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const PAYMENT_PROVIDERS = ["fake", "resend", "postmark"] as const;
