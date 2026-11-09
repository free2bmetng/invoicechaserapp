"use client";

import Link from "next/link";
import { useState } from "react";
import { cancelReminder, holdReminder, resumeReminder, saveReminderEdit } from "@/app/actions/ops";
import { Button } from "@/components/ui";
import { MessageStatusBadge } from "@/components/status";
import type { ReminderDetail } from "@/lib/queries/ops";
import { ActionError, useOpsAction } from "./feedback";
import { ConfirmInline } from "./confirm-inline";
import { ReminderEditor } from "./reminder-editor";
import { ReminderSummary } from "./reminder-view";

export type ScheduleRowData = ReminderDetail & { timeLabel: string };

export function ScheduleRow({ reminder }: { reminder: ScheduleRowData }) {
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useOpsAction();
  const messageId = reminder.id;
  const held = reminder.status === "held";
  const awaitingApproval = reminder.status === "pending_approval";

  return (
    <li className="grid gap-3 px-5 py-5 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-5 sm:px-6">
      {/* The time stands alone in its column, so the status pill never has to fit beside it. */}
      <p className="num text-[15px] font-semibold text-ink">{reminder.timeLabel}</p>

      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="min-w-0">
          <p className="text-[15px] leading-6 font-semibold text-ink">
            <span className="break-words">{reminder.clientName}</span>
            <span className="text-ink-3"> · </span>
            <span className="num text-ink-2">{reminder.invoiceNumber}</span>
          </p>
          <p className="text-[13px] leading-5 text-ink-2">{reminder.stepLabel}</p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <MessageStatusBadge status={reminder.status} />
          <Link href={`/invoices/${reminder.invoiceId}`} className="inline-flex min-h-11 items-center text-[13px] font-medium text-accent underline-offset-4 hover:underline">
            View invoice
          </Link>
        </div>

        {awaitingApproval ? (
          <p className="text-[13px] leading-5 text-ink-2">
            Waiting for your approval.{" "}
            <Link href="/needs-you" className="inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline">
              Review it in Needs you
            </Link>
            .
          </p>
        ) : null}

        {editing ? (
          <ReminderEditor
            messageId={messageId}
            subject={reminder.subject}
            body={reminder.body}
            submitLabel="Save changes"
            action={saveReminderEdit}
            note={
              reminder.requiresApproval && reminder.status !== "pending_approval"
                ? "This step needs approval, so saving sends this reminder back to awaiting approval."
                : null
            }
            onCancel={() => setEditing(false)}
            onDone={() => setEditing(false)}
          />
        ) : (
          <>
            <ReminderSummary reminder={reminder} />
            <div className="flex flex-wrap items-center gap-2">
              {held ? (
                <Button variant="primary" size="sm" disabled={pending} onClick={() => void run(resumeReminder, { messageId })}>
                  Resume
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run(holdReminder, { messageId })}>
                  Hold
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <div className="ml-auto">
                <ConfirmInline
                  trigger="Cancel reminder"
                  triggerVariant="quiet"
                  question="Cancel this reminder?"
                  consequence="It will not be sent. This cannot be undone."
                  confirmLabel="Cancel reminder"
                  pending={pending}
                  onConfirm={() => void run(cancelReminder, { messageId })}
                />
              </div>
            </div>
          </>
        )}

        <ActionError message={error} />
      </div>
    </li>
  );
}
