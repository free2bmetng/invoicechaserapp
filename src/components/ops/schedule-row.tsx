"use client";

// One planned reminder on Next 7 days: a one-line ActionRow (client, invoice and step, amount,
// status, actions). Edit and the cancel confirmation open under the row, across its full width.
import { useEffect, useRef, useState } from "react";
import { approveReminder, cancelReminder, holdReminder, resumeReminder, saveReminderEdit } from "@/app/actions/ops";
import { ActionRow } from "@/components/data";
import { Money } from "@/components/money";
import { MessageStatusBadge } from "@/components/status";
import { Button } from "@/components/ui";
import type { ReminderDetail } from "@/lib/queries/ops";
import { ActionError, useOpsAction } from "./feedback";
import { ReminderEditor } from "./reminder-editor";

export type ScheduleRowData = ReminderDetail & { timeLabel: string };

export function ScheduleRow({ reminder }: { reminder: ScheduleRowData }) {
  const [mode, setMode] = useState<"edit" | "cancel" | null>(null);
  const { pending, error, run } = useOpsAction();
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const previous = useRef(mode);
  const messageId = reminder.id;
  const held = reminder.status === "held";
  const awaiting = reminder.status === "pending_approval";
  const label = `${reminder.invoiceNumber} for ${reminder.clientName}`;

  // Focus follows the confirmation: into it when it opens, back to Cancel when it closes.
  useEffect(() => {
    if (previous.current === mode) return;
    if (mode === "cancel") keepButton.current?.focus();
    else if (previous.current === "cancel") cancelTrigger.current?.focus();
    previous.current = mode;
  }, [mode]);

  return (
    <>
      <ActionRow
        href={`/invoices/${reminder.invoiceId}`}
        client={reminder.clientName}
        title={reminder.invoiceNumber}
        meta={reminder.stepShort}
        amount={<Money minor={reminder.amountMinor} currency={reminder.currency} />}
        status={<MessageStatusBadge status={reminder.status} />}
        actions={
          <>
            {awaiting ? (
              <Button size="sm" disabled={pending} aria-label={`Approve ${label}`} onClick={() => void run(approveReminder, { messageId })}>
                Approve
              </Button>
            ) : held ? (
              <Button size="sm" disabled={pending} aria-label={`Resume ${label}`} onClick={() => void run(resumeReminder, { messageId })}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={pending} aria-label={`Hold ${label}`} onClick={() => void run(holdReminder, { messageId })}>
                Hold
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-expanded={mode === "edit"}
              aria-label={`Edit ${label}`}
              onClick={() => setMode(mode === "edit" ? null : "edit")}
            >
              Edit
            </Button>
            <Button
              ref={cancelTrigger}
              size="sm"
              variant="ghost"
              className="hover:text-danger"
              disabled={pending}
              aria-expanded={mode === "cancel"}
              aria-label={`Cancel ${label}`}
              onClick={() => setMode(mode === "cancel" ? null : "cancel")}
            >
              Cancel
            </Button>
          </>
        }
      />
      {mode || error ? (
        <div className="col-span-full border-b border-line bg-surface-2 px-4 py-4 sm:px-5">
          {mode === "edit" ? (
            <ReminderEditor
              messageId={messageId}
              subject={reminder.subject}
              body={reminder.body}
              submitLabel="Save changes"
              action={saveReminderEdit}
              note={
                reminder.requiresApproval && !awaiting
                  ? "This step needs approval, so saving sends this reminder back to awaiting approval."
                  : null
              }
              onCancel={() => setMode(null)}
              onDone={() => setMode(null)}
            />
          ) : null}
          {mode === "cancel" ? (
            <div role="group" aria-label={`Cancel ${label}?`} className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-small text-ink-2">
                <span className="font-medium text-ink">Cancel this reminder?</span> It will not be sent. This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() => {
                    setMode(null);
                    void run(cancelReminder, { messageId });
                  }}
                >
                  Cancel reminder
                </Button>
                <Button ref={keepButton} size="sm" disabled={pending} onClick={() => setMode(null)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : null}
          <ActionError message={error} />
        </div>
      ) : null}
    </>
  );
}
