"use client";

import Link from "next/link";
import { useState } from "react";
import {
  acknowledgePaidWhileDisputedAction,
  approveReminder,
  approveWithEdit,
  cancelHeldReminders,
  cancelReminder,
  dismissReminderCheck,
  holdReminder,
  markReminderSent,
  resumeAddress,
  resumeClientReminders,
  retryReminder,
} from "@/app/actions/ops";
import { Badge, Button } from "@/components/ui";
import type { NeedsYouRow } from "@/lib/queries/ops";
import { ActionError, useOpsAction } from "./feedback";
import { ConfirmInline } from "./confirm-inline";
import { KIND_BADGE, LINK_BUTTON_PRIMARY } from "./kinds";
import { ReminderEditor } from "./reminder-editor";
import { MessageBody, RecordedAttempt, ReminderPreview, ReminderSummary } from "./reminder-view";

export function NeedsYouCard({ row }: { row: NeedsYouRow }) {
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useOpsAction();
  const reminder = row.reminder;
  const messageId = row.messageId ?? "";
  const badge = KIND_BADGE[row.kind];
  const isApproval = row.kind === "approval";
  // Fixed once the contact's address differs from the one that bounced. Without a record of the
  // bounced address, the card offers resume rather than blocking the user.
  const addressFixed =
    row.bounce !== null && (row.bounce.bouncedEmail === null || row.bounce.currentEmail !== row.bounce.bouncedEmail);

  return (
    <article className="rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:p-6">
      <Badge tone={badge.tone}>{badge.label}</Badge>
      <h3 className="mt-3 text-[16px] font-semibold leading-6 text-ink">{row.title}</h3>

      {/* One or two lines: step and planned date, then recipient and amount. */}
      {reminder ? (
        <div className="mt-1.5 flex flex-col gap-1">
          <p className="text-[14px] leading-6 text-ink-2">
            {reminder.stepLabel}
            {row.plannedLabel ? <span className="text-ink-3"> · planned {row.plannedLabel}</span> : null}
          </p>
          <ReminderSummary reminder={reminder} />
        </div>
      ) : row.kind === "bounce" ? null : (
        <p className="mt-1.5 text-[14px] leading-6 text-ink-2">{row.detail}</p>
      )}

      <nav aria-label="Related pages" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {row.invoiceId ? (
          <Link href={`/invoices/${row.invoiceId}`} className="inline-flex min-h-11 items-center text-[13px] font-medium text-accent underline-offset-4 hover:underline">
            View invoice
          </Link>
        ) : null}
        {row.clientId ? (
          <Link href={`/clients/${row.clientId}`} className="inline-flex min-h-11 items-center text-[13px] font-medium text-accent underline-offset-4 hover:underline">
            View client
          </Link>
        ) : null}
      </nav>

      <div className="mt-4 flex flex-col gap-4">
        {isApproval && reminder ? (
          <>
            {!editing ? (
              <details className="group rounded-[12px] border border-line bg-surface-2">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[12px] px-4 text-[14px] font-medium text-accent [&::-webkit-details-marker]:hidden">
                  <span>Read the message as the client will see it</span>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-180">
                    <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <div className="border-t border-line px-4 py-4">
                  {reminder.preview ? (
                    <MessageBody subject={reminder.preview.subject} text={reminder.preview.text} />
                  ) : (
                    <ReminderPreview reminder={reminder} heading="What the client will read" />
                  )}
                </div>
              </details>
            ) : null}

            {editing ? (
              <ReminderEditor
                messageId={messageId}
                subject={reminder.subject}
                body={reminder.body}
                submitLabel="Save and approve"
                action={approveWithEdit}
                note="Your edits apply to this one reminder only."
                onCancel={() => setEditing(false)}
                onDone={() => setEditing(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={pending} onClick={() => void run(approveReminder, { messageId })}>
                  Approve
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
                  Edit, then approve
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => void run(holdReminder, { messageId })}>
                  Hold
                </Button>
                <ConfirmInline
                  trigger="Cancel reminder"
                  question="Cancel this reminder?"
                  consequence="It will not be sent. This cannot be undone."
                  confirmLabel="Cancel reminder"
                  pending={pending}
                  onConfirm={() => void run(cancelReminder, { messageId })}
                />
              </div>
            )}
          </>
        ) : null}

        {row.kind === "failed" && reminder ? (
          <>
            <ReminderPreview reminder={reminder} heading="The message that did not send" inlineLinkNotice />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={pending} onClick={() => void run(retryReminder, { messageId })}>
                Retry sending
              </Button>
              <ConfirmInline
                trigger="Cancel reminder"
                question="Cancel this reminder?"
                consequence="It will not be sent. This cannot be undone."
                confirmLabel="Cancel reminder"
                pending={pending}
                onConfirm={() => void run(cancelReminder, { messageId })}
              />
            </div>
          </>
        ) : null}

        {row.kind === "needs_check" && reminder ? (
          <>
            <RecordedAttempt reminder={reminder} />
            <p className="text-[13px] leading-5 text-ink-2">
              Mark it as sent only if the client received it or you sent it yourself. Dismiss it if it did not go out and should not.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={pending} onClick={() => void run(markReminderSent, { messageId })}>
                Mark as sent
              </Button>
              <ConfirmInline
                trigger="Dismiss"
                question="Dismiss this reminder without sending it?"
                consequence="It will be marked skipped and will never be sent."
                confirmLabel="Dismiss reminder"
                pending={pending}
                onConfirm={() => void run(dismissReminderCheck, { messageId })}
              />
            </div>
          </>
        ) : null}

        {row.kind === "reply" && row.clientId ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={pending} onClick={() => void run(resumeClientReminders, { clientId: row.clientId ?? "" })}>
              Resume reminders
            </Button>
            <ConfirmInline
              trigger="Cancel held reminders"
              question="Cancel the held reminders for this client?"
              consequence="None of them will be sent. This cannot be undone."
              confirmLabel="Cancel held reminders"
              pending={pending}
              onConfirm={() => void run(cancelHeldReminders, { clientId: row.clientId ?? "" })}
            />
          </div>
        ) : null}

        {row.kind === "bounce" && row.contactId ? (
          addressFixed && row.bounce ? (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] leading-5 text-ink-2">
                The address is now <span className="font-medium break-all text-ink">{row.bounce.currentEmail}</span>. Resume to send
                reminders to it again.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" disabled={pending} onClick={() => void run(resumeAddress, { contactId: row.contactId ?? "" })}>
                  Resume this address
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] leading-5 text-ink-2">Nothing more goes to this address until you fix it on the client page.</p>
              <div>
                <Link href={`/clients/${row.clientId ?? ""}`} className={LINK_BUTTON_PRIMARY}>
                  Fix the address
                </Link>
              </div>
            </div>
          )
        ) : null}

        {row.kind === "paid_while_disputed" && row.invoiceId ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={pending} onClick={() => void run(acknowledgePaidWhileDisputedAction, { invoiceId: row.invoiceId ?? "" })}>
              Mark as reviewed
            </Button>
          </div>
        ) : null}

        {row.kind === "disputed" ? (
          <p className="text-[13px] leading-5 text-ink-2">
            Reminders stay stopped until you change the invoice status. They resume only when it moves back to open or payment plan.
          </p>
        ) : null}

        <ActionError message={error} />
      </div>
    </article>
  );
}
