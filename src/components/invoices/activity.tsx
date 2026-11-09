// The invoice's activity: ONE timeline that merges every reminder (planned, approved, sent,
// delivered, bounced), every hold, every status change, every payment and every note.
// "Coming up" lists what will happen next; "History" lists what happened, newest first.
// One time format throughout (the Timeline primitive's), in the user's timezone.
import Link from "next/link";
import type { ReactNode } from "react";
import { Timeline, type TimelineItem } from "@/components/data";
import { MessageStatusBadge } from "@/components/status";
import { Card } from "@/components/ui";
import type { EventView, InstallmentView, MessageView } from "@/lib/engine";
import type { InvoiceStatus } from "@/lib/types";
import { describeOffset, eventLabel } from "./format";
import { NoteForm } from "./note-form";

const TONE_NAME: Record<string, string> = { friendly: "Friendly", neutral: "Neutral", firm: "Firm", custom: "Custom" };
const UPCOMING: readonly string[] = ["pending_approval", "scheduled", "held", "sending"];
const GROUPED: readonly string[] = ["message_skipped", "message_cancelled", "message_held", "message_released", "payable_paid"];

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export interface ActivityModel {
  upcoming: TimelineItem[];
  history: TimelineItem[];
}

function cancelReason(reason: string | null): string | null {
  switch (reason) {
    case "paid": return "The invoice was marked paid.";
    case "disputed": return "The invoice was marked disputed.";
    case "paused": return "The invoice was paused.";
    case "written_off": return "The invoice was written off.";
    case "installment_paid": return "The installment was paid.";
    case "cancelled_by_user":
    case "user": return "You cancelled them.";
    default: return null;
  }
}

function skipReason(reason: string | null): string {
  switch (reason) {
    case "passed_at_planning":
    case "planned_time_passed":
    case "passed_at_replan":
      return "Their dates had passed when they were planned, so they were never sent late.";
    case "step_removed": return "Their sequence step was removed.";
    case "cancelled_by_user": return "You cancelled them.";
    case "dismissed_after_check": return "You dismissed them after checking delivery.";
    default: return "They will not be sent.";
  }
}

function holdReason(reason: string | null): string | null {
  switch (reason) {
    case "user": return "You put it on hold.";
    case "reply":
    case "client_replied": return "The client replied, so reminders wait for you.";
    case "contact":
    case "bounced": return "The address is on hold.";
    default: return null;
  }
}

function statusTitle(from: string | null, to: string | null): { title: string; tone: TimelineItem["tone"] } {
  switch (to) {
    case "paid": return { title: "Marked as paid", tone: "ok" };
    case "disputed": return { title: "Marked as disputed", tone: "warn" };
    case "paused": return { title: "Reminders paused", tone: "neutral" };
    case "written_off": return { title: "Written off", tone: "neutral" };
    case "payment_plan": return { title: "Payment plan started", tone: "accent" };
    case "open":
      if (from === "disputed") return { title: "Dispute resolved", tone: "accent" };
      if (from === "paused") return { title: "Reminders resumed", tone: "accent" };
      if (from === "paid" || from === "written_off") return { title: "Reopened", tone: "accent" };
      return { title: "Set to open", tone: "accent" };
    default:
      return { title: eventLabel("status_changed", { from, to }), tone: "neutral" };
  }
}

function SentMessage({ message }: { message: MessageView }) {
  if (!message.sent) return null;
  return (
    <details className="group mt-1">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 text-small font-medium text-accent [&::-webkit-details-marker]:hidden">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="transition-transform group-open:rotate-90">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Show the message as sent
      </summary>
      <div className="mt-2 grid gap-2 rounded-[var(--radius-md)] border border-line bg-surface-2 p-3">
        <p className="text-small font-medium text-ink">{message.sent.subject}</p>
        <pre className="font-sans text-small whitespace-pre-wrap text-ink-2">{message.sent.bodySnapshot}</pre>
      </div>
    </details>
  );
}

// Builds both lists. Exported for tests and for reuse; pure apart from the JSX it returns.
export function buildActivity(messages: MessageView[], events: EventView[], installments: InstallmentView[]): ActivityModel {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const position = new Map(installments.map((i) => [i.id, i.position]));
  const stepText = (m: MessageView): string => {
    const n = m.installmentId ? position.get(m.installmentId) : undefined;
    const anchor = m.installmentId ? (n ? `installment ${n}'s due date` : "the installment due date") : "the due date";
    const step = describeOffset(m.stepOffsetDays, anchor);
    const tone = m.stepTone ? TONE_NAME[m.stepTone] ?? m.stepTone : null;
    return tone ? `${step} · ${tone} tone` : step;
  };

  const UPCOMING_TITLE: Record<string, string> = {
    pending_approval: "Reminder waits for your approval",
    scheduled: "Reminder scheduled",
    held: "Reminder on hold",
    sending: "Reminder sending",
  };
  let reviewLinkShown = false;
  const upcoming: TimelineItem[] = messages
    .filter((m) => UPCOMING.includes(m.status))
    .sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime())
    .map((m) => {
      const showReview = m.status === "pending_approval" && !reviewLinkShown;
      if (showReview) reviewLinkShown = true;
      return {
        at: m.plannedAt.toISOString(),
        tone: m.status === "pending_approval" ? "warn" : "neutral",
        title: UPCOMING_TITLE[m.status] ?? "Reminder",
        detail: (
          <>
            <span className="block">To {m.contactEmail} · {stepText(m)}</span>
            {m.subject ? <span className="block truncate text-ink-3">“{m.subject}”</span> : null}
            {showReview ? (
              <Link href="/needs-you" className="mt-0.5 inline-flex min-h-8 items-center font-medium text-accent underline-offset-4 hover:underline">
                Review in Needs you
              </Link>
            ) : null}
          </>
        ),
      };
    });

  const history: TimelineItem[] = [];
  const sentEventFor = new Set<string>();
  for (const e of events) {
    const id = str(e.detail.scheduled_message_id);
    if (e.type === "message_sent" && id) sentEventFor.add(id);
  }

  // Events arrive newest first. Runs of the same bulk event at the same moment become one item.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const at = e.createdAt.toISOString();
    const reason = str(e.detail.reason);
    const messageId = str(e.detail.scheduled_message_id);
    const message = messageId ? byId.get(messageId) : undefined;

    if (GROUPED.includes(e.type)) {
      let n = 1;
      while (
        i + n < events.length &&
        events[i + n].type === e.type &&
        Math.abs(events[i + n].createdAt.getTime() - e.createdAt.getTime()) < 1000 &&
        str(events[i + n].detail.reason) === reason
      ) {
        n++;
      }
      i += n - 1;
      if (e.type === "message_skipped") {
        history.push({ at, tone: "neutral", title: plural(n, "reminder skipped", "reminders skipped"), detail: skipReason(reason) });
      } else if (e.type === "message_cancelled") {
        history.push({ at, tone: "neutral", title: plural(n, "reminder cancelled", "reminders cancelled"), detail: cancelReason(reason) });
      } else if (e.type === "message_held") {
        history.push({ at, tone: "warn", title: n === 1 ? "Reminder put on hold" : `${n} reminders put on hold`, detail: holdReason(reason) });
      } else if (e.type === "message_released") {
        history.push({ at, tone: "accent", title: n === 1 ? "Reminder released from hold" : `${n} reminders released from hold` });
      } else {
        history.push({ at, tone: "ok", title: n === 1 ? "Installment marked paid" : `${n} installments marked paid` });
      }
      continue;
    }

    let item: Omit<TimelineItem, "at"> | null = null;
    switch (e.type) {
      case "invoice_created": {
        const source = str(e.detail.source);
        item = { tone: "neutral", title: "Invoice added", detail: source === "csv" ? "Imported from a CSV file." : source === "stripe" ? "Synced from Stripe." : "Added by hand." };
        break;
      }
      case "invoice_updated":
        item = { tone: "neutral", title: "Details edited" };
        break;
      case "status_changed": {
        const to = str(e.detail.to);
        // Said once: a plan's start is the "Payment plan set up" item, and a recorded payment
        // already says the invoice is paid.
        if (to === "payment_plan") break;
        if (to === "paid" && events.some((p) => p.type === "payment_recorded" && Math.abs(p.createdAt.getTime() - e.createdAt.getTime()) < 5000)) break;
        const s = statusTitle(str(e.detail.from), to);
        item = { tone: s.tone, title: s.title };
        break;
      }
      case "payment_recorded": {
        const instId = str(e.detail.installment_id);
        const n = instId ? position.get(instId) : undefined;
        const source = str(e.detail.source);
        item = {
          tone: "ok",
          title: instId ? (n ? `Installment ${n} paid` : "Installment paid") : "Payment received",
          detail: source === "stripe" ? "Paid through Stripe." : "Recorded by you.",
        };
        break;
      }
      case "payment_plan_set": {
        const count = typeof e.detail.installments === "number" ? e.detail.installments : null;
        item = { tone: "accent", title: "Payment plan set up", detail: count ? `${count} installments, each with its own reminders.` : null };
        break;
      }
      case "message_sent": {
        const delivered = message?.status === "delivered";
        const bounced = message?.status === "bounced";
        item = {
          tone: bounced ? "danger" : "ok",
          title: (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Reminder sent</span>
              {delivered ? <MessageStatusBadge status="delivered" /> : null}
            </span>
          ),
          detail: message ? (
            <>
              To {message.contactEmail} · {stepText(message)}
              {message.sent?.manual ? " · marked as sent by you" : ""}
              <SentMessage message={message} />
            </>
          ) : null,
        };
        break;
      }
      case "message_bounced":
        item = { tone: "danger", title: "Reminder bounced", detail: message ? `${message.contactEmail} did not accept it. Reminders to this address are on hold.` : null };
        break;
      case "message_failed":
      case "send_error":
        item = { tone: "danger", title: "Reminder failed to send", detail: message ? `To ${message.contactEmail}.` : null };
        break;
      case "needs_check":
        item = { tone: "warn", title: "Reminder needs a delivery check", detail: "It may or may not have been sent. Check it in Needs you." };
        break;
      case "message_approved":
        item = { tone: "accent", title: "Reminder approved", detail: message ? stepText(message) : null };
        break;
      case "message_edited":
        item = { tone: "neutral", title: "Reminder edited", detail: message ? stepText(message) : null };
        break;
      case "message_resumed":
        item = { tone: "accent", title: "Reminder resumed" };
        break;
      case "message_deferred":
        item = { tone: "neutral", title: "Reminder moved to the next send window" };
        break;
      case "client_replied":
        item = { tone: "warn", title: "Client replied", detail: "Reminders to this client wait until you resume them." };
        break;
      case "client_resumed":
        item = { tone: "accent", title: "Reminders resumed for this client" };
        break;
      case "contact_held":
        item = { tone: "warn", title: "Address put on hold" };
        break;
      case "contact_resumed":
        item = { tone: "accent", title: "Address resumed" };
        break;
      case "paid_while_disputed":
        item = { tone: "warn", title: "Paid while disputed", detail: "Check the dispute with the client." };
        break;
      case "paid_while_disputed_acknowledged":
        item = { tone: "neutral", title: "Dispute payment checked" };
        break;
      case "payment_link_created":
        item = { tone: "neutral", title: "Payment link created" };
        break;
      case "planning_blocked":
        item = { tone: "warn", title: "Reminders could not be planned", detail: str(e.detail.message) ?? str(e.detail.reason) };
        break;
      case "invoice_note": {
        const note = str(e.detail.note) ?? "";
        item = {
          tone: "accent",
          title: "Note",
          detail: <span className="mt-1 block border-l-2 border-line-strong pl-3 text-body whitespace-pre-line text-ink">{note}</span>,
        };
        break;
      }
      default:
        item = { tone: "neutral", title: eventLabel(e.type, e.detail) };
    }
    if (item) history.push({ ...item, at });
  }

  // A sent message whose "sent" event is missing still belongs in the history.
  for (const m of messages) {
    if (!m.sent || sentEventFor.has(m.id)) continue;
    history.push({
      at: m.sent.sentAt.toISOString(),
      tone: m.status === "bounced" ? "danger" : "ok",
      title: "Reminder sent",
      detail: (
        <>
          To {m.contactEmail} · {stepText(m)}
          <SentMessage message={m} />
        </>
      ),
    });
  }
  history.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { upcoming, history };
}

export function Activity({
  invoiceId,
  status,
  messages,
  events,
  installments,
  zone,
  upcomingNote,
}: {
  invoiceId: string;
  status: InvoiceStatus;
  messages: MessageView[];
  events: EventView[];
  installments: InstallmentView[];
  zone: string;
  // Why nothing is coming up, when that needs saying (setup, sender profile, a stopped status).
  upcomingNote: ReactNode;
}) {
  const { upcoming, history } = buildActivity(messages, events, installments);
  return (
    <Card as="section" className="overflow-hidden">
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        <h2 id="activity-heading" className="text-section-title text-ink">Activity</h2>
      </div>

      <div className="px-4 pt-4 sm:px-6">
        <NoteForm invoiceId={invoiceId} placeholder={status === "disputed" ? "Add a note about the dispute" : "Add a note, like a call or a promise to pay"} />
      </div>

      {status === "paid" || status === "written_off" ? null : (
        <section aria-labelledby="upcoming-heading" className="px-4 pt-6 sm:px-6">
          <h3 id="upcoming-heading" className="mb-3 text-[12px] font-semibold tracking-[0.06em] text-ink-3 uppercase">Coming up</h3>
          {upcoming.length > 0 ? (
            <Timeline items={upcoming} zone={zone} />
          ) : (
            <p className="text-small text-ink-2">{upcomingNote ?? "No reminders are planned."}</p>
          )}
        </section>
      )}

      <section aria-labelledby="history-heading" className="mt-6 border-t border-line px-4 py-5 sm:px-6">
        <h3 id="history-heading" className="mb-3 text-[12px] font-semibold tracking-[0.06em] text-ink-3 uppercase">History</h3>
        {history.length > 0 ? <Timeline items={history} zone={zone} /> : <p className="text-small text-ink-2">Nothing has happened yet.</p>}
      </section>
    </Card>
  );
}
