// Which actions an invoice offers, by status: ONE main action, and the other status changes for
// the secondary "Change status" control. Also the relative due phrases used by the list and the
// detail page. Pure and client-safe, so the rules are tested without a browser.
import { DateTime } from "luxon";
import type { InvoiceStatus } from "@/lib/types";
import { daysBetween, pluralDays } from "./format";

export type MainActionKind = "set_status" | "record_installment";

export interface MainAction {
  kind: MainActionKind;
  label: string;
  // The status the action sets (set_status only).
  status?: InvoiceStatus;
  // Shown under the header buttons after the action succeeds is the server's message; this is
  // the one-line promise of what the click does, used as the button's description.
  hint: string;
  // Reopen is the main action on a closed invoice, but it is not something to encourage.
  variant: "primary" | "secondary";
}

// Open → Mark as paid. Paused → Resume reminders. Disputed → Resolve dispute.
// Payment plan → Record installment. Paid or written off → Reopen.
export function mainActionFor(status: InvoiceStatus, opts: { hasOpenInstallment?: boolean } = {}): MainAction {
  switch (status) {
    case "open":
      return { kind: "set_status", status: "paid", label: "Mark as paid", hint: "Stops every reminder for this invoice.", variant: "primary" };
    case "paused":
      return { kind: "set_status", status: "open", label: "Resume reminders", hint: "Reminders still in the future are planned again. Missed ones are not sent late.", variant: "primary" };
    case "disputed":
      return { kind: "set_status", status: "open", label: "Resolve dispute", hint: "Sets the invoice back to open. Reminders still in the future are planned again.", variant: "primary" };
    case "payment_plan":
      return opts.hasOpenInstallment === false
        ? { kind: "set_status", status: "paid", label: "Mark as paid", hint: "Stops every reminder for this invoice.", variant: "primary" }
        : { kind: "record_installment", label: "Record installment", hint: "Marks the next unpaid installment as paid and stops its reminders.", variant: "primary" };
    case "paid":
      return { kind: "set_status", status: "open", label: "Reopen", hint: "Sets the invoice back to open, so you can edit it and reminders can resume.", variant: "secondary" };
    case "written_off":
      return { kind: "set_status", status: "open", label: "Reopen", hint: "Sets the invoice back to open. Reminders still in the future are planned again.", variant: "secondary" };
  }
}

export interface StatusChange {
  status: InvoiceStatus;
  label: string;
  description: string;
  // Asks for a second click (and, for a dispute, an optional reason) before it runs.
  confirm: "none" | "reason" | "danger";
}

const CHANGE: Record<"paid" | "paused" | "disputed" | "written_off" | "open", StatusChange> = {
  paid: { status: "paid", label: "Mark as paid", description: "Stops every reminder. Nothing is sent after this.", confirm: "none" },
  paused: { status: "paused", label: "Pause reminders", description: "Nothing is sent until you resume.", confirm: "none" },
  disputed: { status: "disputed", label: "Mark as disputed", description: "Stops reminders while you sort it out with the client.", confirm: "reason" },
  written_off: { status: "written_off", label: "Write off", description: "Closes the invoice without collecting the money.", confirm: "danger" },
  open: { status: "open", label: "Set back to open", description: "Reminders still in the future are planned again.", confirm: "none" },
};

// The other changes, never the current status and never the main action again.
// A paid invoice offers nothing but Reopen (its main action).
export function statusChangesFor(status: InvoiceStatus): StatusChange[] {
  switch (status) {
    case "open":
      return [CHANGE.paused, CHANGE.disputed, CHANGE.written_off];
    case "paused":
      return [CHANGE.paid, CHANGE.disputed, CHANGE.written_off];
    case "disputed":
      return [CHANGE.paid, CHANGE.paused, CHANGE.written_off];
    case "payment_plan":
      return [CHANGE.paid, CHANGE.paused, CHANGE.disputed, CHANGE.written_off];
    case "written_off":
      return [CHANGE.paid];
    case "paid":
      return [];
  }
}

export type PhraseTone = "danger" | "warn" | "muted" | "neutral" | "ok";

// "Due today", "Due tomorrow", "Due in 5 days", "1 day overdue", "21 days overdue".
export function dueWhen(dueIso: string, todayIso: string): { text: string; tone: PhraseTone; overdueDays: number } {
  const diff = daysBetween(todayIso, dueIso);
  if (diff === 0) return { text: "Due today", tone: "warn", overdueDays: 0 };
  if (diff === 1) return { text: "Due tomorrow", tone: "neutral", overdueDays: 0 };
  if (diff > 1) return { text: `Due in ${pluralDays(diff)}`, tone: "neutral", overdueDays: 0 };
  return { text: `${pluralDays(-diff)} overdue`, tone: "danger", overdueDays: -diff };
}

// "Paid 2 days late", "Paid on time", "Paid 3 days early", from the paid instant's date in the zone.
export function paidTiming(paidAt: Date | string, dueIso: string, zone: string): string {
  const iso = typeof paidAt === "string" ? paidAt : paidAt.toISOString();
  const paidDay = DateTime.fromISO(iso).setZone(zone).toISODate() ?? dueIso;
  const late = daysBetween(dueIso, paidDay);
  if (late === 0) return "Paid on the due date";
  return late > 0 ? `Paid ${pluralDays(late)} late` : `Paid ${pluralDays(-late)} early`;
}

// "Fri 13 Nov" style short date for a calendar date, with the year only when it differs.
export function shortDate(iso: string, todayIso: string): string {
  const d = DateTime.fromISO(iso, { zone: "utc" }).setLocale("en");
  return d.year === DateTime.fromISO(todayIso, { zone: "utc" }).year ? d.toFormat("d LLL") : d.toFormat("d LLL yyyy");
}
