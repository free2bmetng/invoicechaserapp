// Read-only views of one reminder: who it goes to, what it is for, and the exact text.
// Plain components, usable from server and client components.
import { Fragment, type ReactNode } from "react";
import { Money } from "@/components/money";
import type { ReminderDetail } from "@/lib/queries/ops";
import { PAY_LINK_PLACEHOLDER } from "@/lib/templates";

export const PAY_LINK_NOTICE = "A payment link is added automatically when this sends, if Stripe is connected.";

// A compact one-line summary: recipient, the step (optional) and the amount.
export function ReminderSummary({ reminder, showStep = false }: { reminder: ReminderDetail; showStep?: boolean }) {
  const items: ReactNode[] = [
    <span key="to" className="min-w-0 break-all text-ink">{reminder.contactEmail}</span>,
  ];
  if (showStep) items.push(<span key="step">{reminder.stepLabel}</span>);
  items.push(
    <span key="amount" className="text-ink">
      <Money minor={reminder.amountMinor} currency={reminder.currency} />
    </span>,
  );
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-5 text-ink-2">
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-ink-3">
              ·
            </span>
          ) : null}
          {item}
        </Fragment>
      ))}
    </p>
  );
}

// The message text, exactly as it will be written. Nothing is styled inside it.
export function MessageText({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words text-[14px] leading-6 text-ink-2">{text}</div>;
}

// Subject and body, without a frame. A message that carries the payment-link placeholder gets a
// notice above it, so the approver knows the link is added at send time without the text changing.
export function MessageBody({ subject, text, noticeAbove = true }: { subject: string; text: string; noticeAbove?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {noticeAbove && text.includes(PAY_LINK_PLACEHOLDER) ? (
        <p className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] leading-5 text-ink-2">
          {PAY_LINK_NOTICE}
        </p>
      ) : null}
      <p className="text-[14px] font-medium leading-6 break-words text-ink">{subject}</p>
      <MessageText text={text} />
    </div>
  );
}

// The rendered message, or the reason it cannot be shown.
export function ReminderPreview({
  reminder,
  heading,
  inlineLinkNotice = false,
}: {
  reminder: ReminderDetail;
  heading: string;
  // Replaces the literal payment-link placeholder in the text with the notice wording.
  inlineLinkNotice?: boolean;
}) {
  if (!reminder.preview) {
    return (
      <p className="rounded-[12px] border border-warn/25 bg-warn-soft px-4 py-3 text-[13px] leading-5 text-warn">
        {reminder.previewNote ?? "This message cannot be shown yet."}
      </p>
    );
  }
  return (
    <section aria-label={heading} className="rounded-[12px] border border-line bg-surface-2 p-4">
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">{heading}</p>
      <div className="mt-2">
        <MessageBody
          subject={reminder.preview.subject}
          text={inlineLinkNotice ? reminder.preview.text.split(PAY_LINK_PLACEHOLDER).join(PAY_LINK_NOTICE) : reminder.preview.text}
          noticeAbove={!inlineLinkNotice}
        />
      </div>
    </section>
  );
}

// The text recorded before the provider was called, for rows that may have gone out.
export function RecordedAttempt({ reminder }: { reminder: ReminderDetail }) {
  if (!reminder.attempt) return <ReminderPreview reminder={reminder} heading="What was meant to be sent" />;
  return (
    <section aria-label="What was sent" className="rounded-[12px] border border-line bg-surface-2 p-4">
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">The exact text recorded before sending</p>
      <div className="mt-2">
        <MessageBody subject={reminder.attempt.subject} text={reminder.attempt.text} />
      </div>
    </section>
  );
}
