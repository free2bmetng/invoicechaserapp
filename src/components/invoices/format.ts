// Client-safe display helpers for the invoice, client and sequence screens. Pure functions only:
// no database, no engine imports, so client components can use them.
import { DateTime } from "luxon";
import { currencyExponent } from "@/lib/money";
import type { InvoiceStatus } from "@/lib/types";

export const OUTSTANDING_STATUSES: readonly InvoiceStatus[] = ["open", "payment_plan", "paused", "disputed"];

// "12.50" for USD 1250 minor units, "1234" for JPY. No floating-point rounding.
export function minorToInput(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(minor);
  const digits = String(minor).padStart(exp + 1, "0");
  return `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

// "8 Nov 2026" for a YYYY-MM-DD calendar date. Calendar dates are never shifted by a timezone.
export function dueDateLabel(iso: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setLocale("en").toFormat("d LLL yyyy");
}

// "Tue 10 Nov, 9:00 AM" for an instant, shown in the given zone.
export function instantLabel(iso: string, zone: string): string {
  return DateTime.fromISO(iso).setZone(zone).setLocale("en").toFormat("EEE d LLL, h:mm a");
}

// Today's calendar date (YYYY-MM-DD) in the zone.
export function todayIn(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toISODate() ?? "";
}

export function addDaysIso(iso: string, days: number): string {
  return DateTime.fromISO(iso, { zone: "utc" }).plus({ days }).toISODate() ?? iso;
}

// Whole days from one calendar date to another (to - from).
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(DateTime.fromISO(toIso, { zone: "utc" }).diff(DateTime.fromISO(fromIso, { zone: "utc" }), "days").days);
}

export function isOverdue(dueIso: string, todayIsoDate: string): boolean {
  return dueIso < todayIsoDate;
}

export function pluralDays(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: "Open",
  paid: "Paid",
  paused: "Paused",
  disputed: "Disputed",
  payment_plan: "Payment plan",
  written_off: "Written off",
};

// Plain explanations for the status controls. Each says whether it stops everything.
export const STATUS_CONTROLS: { status: InvoiceStatus; button: string; short: string; explanation: string; stopsEverything: boolean }[] = [
  {
    status: "open",
    short: "Reminders follow the sequence again. Missed steps are skipped.",
    button: "Set to open",
    explanation: "Reminders follow the sequence again. Steps whose time has passed are skipped, not sent late.",
    stopsEverything: false,
  },
  {
    status: "paused",
    short: "Pause every reminder for this invoice.",
    button: "Pause",
    explanation: "Stops everything for this invoice right away. Unsent reminders are cancelled. Setting it back to open schedules only the reminders still in the future.",
    stopsEverything: true,
  },
  {
    status: "disputed",
    short: "The client disputes the invoice. Reminders wait.",
    button: "Mark as disputed",
    explanation: "Stops everything while the client disputes the invoice. Unsent reminders are cancelled. Setting it back to open schedules only the reminders still in the future.",
    stopsEverything: true,
  },
  {
    status: "paid",
    short: "Stripe payments mark it paid automatically.",
    button: "Mark as paid",
    explanation: "Stops everything. Unsent reminders are cancelled and nothing is sent after this. Payments through Stripe mark invoices paid automatically.",
    stopsEverything: true,
  },
  {
    status: "written_off",
    short: "Close the invoice without collecting the money.",
    button: "Write off",
    explanation: "Stops everything. Unsent reminders are cancelled and the invoice is closed. Setting it back to open resumes reminders for the steps still in the future.",
    stopsEverything: true,
  },
];

export const STOPPED_STATUSES: readonly InvoiceStatus[] = ["paid", "paused", "disputed", "written_off"];

export interface NextMessageView {
  status: string;
  plannedAt: string;
  requiresApproval: boolean;
}

// The "next message" line in plain English.
export function describeNextMessage(args: {
  invoiceStatus: InvoiceStatus;
  next: NextMessageView | null;
  zone: string;
  profileComplete: boolean;
  onboardingDone: boolean;
}): string {
  const { invoiceStatus, next, zone, profileComplete, onboardingDone } = args;
  if (invoiceStatus === "paid") return "Paid. No reminders are sent.";
  if (invoiceStatus === "written_off") return "Written off. Nothing more is sent.";
  if (invoiceStatus === "paused") return "Paused. Nothing is sent until you set it back to open.";
  if (invoiceStatus === "disputed") return "Disputed. Nothing is sent while it is disputed.";
  // Planning waits for onboarding, so an invoice added before it finishes has no reminders yet.
  if (!onboardingDone) return "Waiting for setup to finish.";
  if (!profileComplete) return "Reminders wait until your sender profile is complete in Settings.";
  if (!next) return "No reminders left to send.";
  if (next.status === "pending_approval") return `Reminder waiting for your approval (planned ${instantLabel(next.plannedAt, zone)}).`;
  if (next.status === "held") return "A reminder is on hold.";
  return `Next reminder ${instantLabel(next.plannedAt, zone)}.`;
}

export const EVENT_LABELS: Record<string, string> = {
  invoice_created: "Invoice created",
  invoice_updated: "Invoice edited",
  status_changed: "Status changed",
  payment_recorded: "Payment recorded",
  payable_paid: "Payment recorded for an installment",
  payment_plan_set: "Payment plan saved",
  message_approved: "Reminder approved",
  message_edited: "Reminder edited",
  message_held: "Reminder put on hold",
  message_resumed: "Reminder resumed",
  message_cancelled: "Reminder cancelled",
  message_skipped: "Reminder skipped",
  message_sent: "Reminder sent",
  message_delivered: "Reminder delivered",
  message_bounced: "Reminder bounced",
  message_failed: "Reminder failed to send",
  message_deferred: "Reminder moved to the next send window",
  message_pending_again: "Reminder waiting for approval again",
  message_released: "Reminder released",
  message_retried: "Reminder queued for retry",
  message_deleted: "Reminder removed",
  message_cancelled_for_status: "Reminders cancelled",
  step_deleted: "Sequence step removed",
  planning_blocked: "Reminders could not be planned",
  needs_check: "Reminder needs a delivery check",
  delivery_failed: "Delivery failed",
  contact_held: "Address held",
  contact_resumed: "Address resumed",
  client_replied: "Client replied",
  client_resumed: "Reminders resumed for client",
  client_created: "Client created",
  client_updated: "Client edited",
  auto_send_changed: "Auto-send changed",
  contact_added: "Contact added",
  contact_updated: "Contact edited",
  contact_removed: "Contact removed",
  sequence_saved: "Sequence saved",
};

// A one-line description of one event. Status changes name both statuses.
export function eventLabel(type: string, detail: Record<string, unknown>): string {
  if (type === "status_changed") {
    const from = typeof detail.from === "string" ? detail.from : "";
    const to = typeof detail.to === "string" ? detail.to : "";
    const label = (s: string) => INVOICE_STATUS_LABEL[s as InvoiceStatus] ?? s;
    if (from && to) return `Status changed from ${label(from)} to ${label(to)}`;
  }
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  return type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// "3 days before the due date", "on the due date", "7 days after the due date".
export function describeOffset(offsetDays: number | null, anchor: string): string {
  if (offsetDays === null) return "Step removed";
  if (offsetDays === 0) return `On ${anchor}`;
  const n = Math.abs(offsetDays);
  return offsetDays < 0 ? `${pluralDays(n)} before ${anchor}` : `${pluralDays(n)} after ${anchor}`;
}

// "8 Nov 2026" for an instant, shown as its date in the zone.
export function dayLabelFor(iso: string, zone: string): string {
  return DateTime.fromISO(iso).setZone(zone).setLocale("en").toFormat("d LLL yyyy");
}

// "Tue 10 Nov, 9:00:00 AM": the seconds show when two events share a minute.
export function instantLabelWithSeconds(iso: string, zone: string): string {
  return DateTime.fromISO(iso).setZone(zone).setLocale("en").toFormat("EEE d LLL, h:mm:ss a");
}

// The payment-timing figure: the mean days from due date to paid date. Negative means paid early,
// null means nothing has been paid yet (shown as a dash by the caller).
export function lateLabel(value: number | null): string | null {
  if (value === null) return null;
  if (value < 0) return "Paid early";
  const days = Math.round(value);
  if (days === 0) return "On time";
  return `${days} ${days === 1 ? "day" : "days"} late`;
}

// The line under a skipped reminder. Planned-time reasons all use the same sentence.
const PLANNED_TIME_PASSED = "Skipped. Its due date had passed when this reminder was planned, so it was never sent late.";
export function skippedLine(reason: string | undefined): string {
  if (reason === "planned_time_passed" || reason === "passed_at_replan") return PLANNED_TIME_PASSED;
  if (reason === "cancelled_by_user") return "Skipped. You cancelled this reminder.";
  if (reason === "dismissed_after_check") return "Skipped. You dismissed this reminder after checking delivery.";
  if (reason === "step_removed") return "Skipped. Its step was removed from the sequence.";
  return "Skipped. This reminder will not be sent.";
}
