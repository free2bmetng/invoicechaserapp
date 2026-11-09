// The message timeline and event history for one invoice. Server-rendered from engine reads.
import Link from "next/link";
import { MessageStatusBadge } from "@/components/status";
import { describeOffset, eventLabel, instantLabel, instantLabelWithSeconds } from "./format";
import type { MessageStatus } from "@/lib/types";
import type { EventView, MessageView } from "@/lib/engine";

const TONE_NAME: Record<string, string> = { friendly: "Friendly", neutral: "Neutral", firm: "Firm", custom: "Custom" };

export function Timeline({ messages, events, zone }: { messages: MessageView[]; events: EventView[]; zone: string }) {
  return (
    <div className="grid gap-8">
      <section aria-labelledby="reminders-heading" className="grid gap-3">
        <h3 id="reminders-heading" className="text-[14px] font-semibold text-ink">Reminders</h3>
        {messages.length === 0 ? (
          <p className="text-[14px] leading-6 text-ink-2">
            No reminders are planned for this invoice. They appear here once the sender profile is complete and the invoice is open or on a payment plan.
          </p>
        ) : (
          <ol className="grid gap-3">
            {messages.map((m) => {
              const anchor = m.installmentId ? "the installment due date" : "the due date";
              const step = m.stepOffsetDays === null ? "Step removed" : describeOffset(m.stepOffsetDays, anchor);
              const tone = m.stepTone ? TONE_NAME[m.stepTone] ?? m.stepTone : null;
              return (
                <li key={m.id} className="grid gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="num text-[14px] font-medium text-ink">{instantLabel(m.plannedAt.toISOString(), zone)}</p>
                    <MessageStatusBadge status={m.status as MessageStatus} />
                  </div>
                  <p className="text-[13px] text-ink-2">
                    {step}{tone ? ` · ${tone} tone` : ""} · to {m.contactEmail}
                    {m.requiresApproval ? " · needs approval" : ""}
                  </p>
                  {m.sent ? (
                    <details className="group">
                      <summary className="cursor-pointer text-[13px] font-medium text-accent">
                        Sent {instantLabel(m.sent.sentAt.toISOString(), zone)}
                        {m.sent.manual ? " (marked as sent by you)" : ""}. Show the message as sent
                      </summary>
                      <div className="mt-3 grid gap-2 rounded-[var(--radius-md)] bg-surface-2 p-3">
                        <p className="text-[13px] font-medium text-ink">Subject: {m.sent.subject}</p>
                        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-6 text-ink-2">{m.sent.bodySnapshot}</pre>
                      </div>
                    </details>
                  ) : (
                    <p className="text-[13px] leading-5 text-ink-3">
                      Subject: {m.subject || "(from the sequence)"}
                    </p>
                  )}
                  {m.status === "pending_approval" ? (
                    <p className="text-[13px]">
                      <Link href="/needs-you" className="font-medium text-accent underline underline-offset-4">Review in Needs you</Link>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="history-heading" className="grid gap-3">
        <h3 id="history-heading" className="text-[14px] font-semibold text-ink">History</h3>
        {events.length === 0 ? (
          <p className="text-[14px] text-ink-2">Nothing has happened to this invoice yet.</p>
        ) : (
          <ul className="grid gap-2">
            {events.map((e) => (
              <li key={e.id} className="grid gap-0.5 border-l-2 border-line pl-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4 sm:border-l-0 sm:pl-0">
                <time dateTime={e.createdAt.toISOString()} className="num text-[13px] text-ink-3">{instantLabelWithSeconds(e.createdAt.toISOString(), zone)}</time>
                <p className="text-[14px] text-ink">{eventLabel(e.type, e.detail)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
