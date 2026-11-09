// A preview of the first reminder a new invoice would get, beside the form on desktop.
// Pure rendering from the chosen sequence's steps: no server call while the user types.
import { DateTime } from "luxon";
import { Card, cx } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { addDaysIso, describeOffset, dueDateLabel, pluralDays } from "./format";

export interface PreviewStep {
  offsetDays: number;
  tone: string;
  subject: string;
  body: string;
  requiresApproval: boolean;
}

export interface PreviewSequence {
  id: string;
  name: string;
  steps: PreviewStep[];
}

const TONE: Record<string, string> = { friendly: "Friendly", neutral: "Neutral", firm: "Firm", custom: "Custom" };

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (match, name: string) => (name === "pay_link" ? "[payment link]" : values[name] ?? match));
}

export function ReminderPreview({
  sequence,
  today,
  dueDate,
  amountMinor,
  currency,
  invoiceNumber,
  clientName,
  recipient,
  sender,
}: {
  sequence: PreviewSequence | null;
  today: string;
  dueDate: string;
  amountMinor: number | null;
  currency: string;
  invoiceNumber: string;
  clientName: string;
  recipient: string;
  sender: { senderName: string; businessName: string };
}) {
  const validDue = /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && DateTime.fromISO(dueDate).isValid;
  const steps = sequence ? [...sequence.steps].sort((a, b) => a.offsetDays - b.offsetDays) : [];
  // Steps whose date has already passed are skipped, never sent late.
  const upcoming = validDue ? steps.filter((s) => addDaysIso(dueDate, s.offsetDays) >= today) : [];
  const firstStep = upcoming[0] ?? null;
  const later = upcoming.slice(1);

  let amountText = "[amount]";
  if (amountMinor !== null) {
    try {
      amountText = formatMoney(amountMinor, currency);
    } catch {
      amountText = "[amount]";
    }
  }
  const values: Record<string, string> = {
    client_name: clientName || "[client name]",
    invoice_number: invoiceNumber || "[invoice number]",
    amount: amountText,
    currency,
    due_date: validDue ? dueDateLabel(dueDate) : "[due date]",
    days_overdue: firstStep && firstStep.offsetDays > 0 ? String(firstStep.offsetDays) : "0",
    sender_name: sender.senderName || "you",
    business_name: sender.businessName || "your business",
  };

  return (
    <Card as="section" className="overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-card-title text-ink">First reminder</h2>
        <p className="mt-0.5 text-small text-ink-3">{sequence ? `From the ${sequence.name} sequence` : "No sequence"}</p>
      </div>
      {!validDue ? (
        <p className="px-5 py-5 text-small text-ink-2">Enter a due date to see when the first reminder goes out.</p>
      ) : !firstStep ? (
        <p className="px-5 py-5 text-small text-ink-2">
          Every step of this sequence falls before today, so no reminders would be sent. Choose a later due date or another sequence.
        </p>
      ) : (
        <div className="grid gap-4 px-5 py-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <rect x="2.5" y="4.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="m3.5 6 6.5 5 6.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="num text-body font-medium text-ink">{DateTime.fromISO(addDaysIso(dueDate, firstStep.offsetDays)).setLocale("en").toFormat("EEE d LLL yyyy")}</p>
              <p className="text-small text-ink-2">
                {describeOffset(firstStep.offsetDays, "the due date")} · {TONE[firstStep.tone] ?? firstStep.tone} tone
                {firstStep.requiresApproval ? " · waits for your approval" : ""}
              </p>
            </div>
          </div>
          <div className="grid gap-2 rounded-[var(--radius-md)] border border-line bg-surface-2 p-3 text-small">
            <p className="truncate text-ink-3">
              To <span className="text-ink-2">{recipient || "the client's contact"}</span>
            </p>
            <p className="font-medium text-ink">{fill(firstStep.subject, values)}</p>
            <p className="line-clamp-6 whitespace-pre-line text-ink-2">{fill(firstStep.body, values).trim()}</p>
          </div>
          {later.length > 0 ? (
            <p className={cx("text-small text-ink-3")}>
              Then {later.length} more {later.length === 1 ? "reminder" : "reminders"}, the last{" "}
              {later[later.length - 1].offsetDays === 0
                ? "on the due date"
                : later[later.length - 1].offsetDays > 0
                  ? `${pluralDays(later[later.length - 1].offsetDays)} after the due date`
                  : `${pluralDays(-later[later.length - 1].offsetDays)} before the due date`}
              . Reminders stop as soon as the invoice is paid.
            </p>
          ) : (
            <p className="text-small text-ink-3">This is the only reminder left in the sequence. Reminders stop as soon as the invoice is paid.</p>
          )}
        </div>
      )}
    </Card>
  );
}
