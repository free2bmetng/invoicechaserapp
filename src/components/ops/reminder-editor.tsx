"use client";

import { useId, type FormEvent } from "react";
import { Button, Field, Textarea, TextInput } from "@/components/ui";
import { ActionError, useOpsAction, type OpsAction } from "./feedback";

const MERGE_FIELD_HINT =
  "Merge fields fill in automatically: {client_name}, {invoice_number}, {amount}, {currency}, {due_date}, {days_overdue}, {pay_link}, {sender_name}, {business_name}.";

// Inline subject and body editor. It saves through a server action, so the text is
// validated again on the server.
export function ReminderEditor({
  messageId,
  subject,
  body,
  submitLabel,
  action,
  note,
  onCancel,
  onDone,
}: {
  messageId: string;
  subject: string;
  body: string;
  submitLabel: string;
  action: OpsAction;
  note?: string | null;
  onCancel: () => void;
  onDone?: () => void;
}) {
  const ids = useId();
  const { pending, error, run } = useOpsAction();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ok = await run(action, {
      messageId,
      subject: String(data.get("subject") ?? ""),
      body: String(data.get("body") ?? ""),
    });
    if (ok) onDone?.();
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Edit reminder"
      className="flex flex-col gap-4 rounded-[12px] border border-line bg-surface-2 p-4"
    >
      <Field id={`${ids}-subject`} label="Subject" hint={MERGE_FIELD_HINT}>
        <TextInput id={`${ids}-subject`} name="subject" defaultValue={subject} required maxLength={300} disabled={pending} />
      </Field>
      <Field id={`${ids}-body`} label="Message" hint="Plain text. Your sender details and footer are added automatically.">
        <Textarea id={`${ids}-body`} name="body" defaultValue={body} required rows={9} maxLength={10000} disabled={pending} />
      </Field>
      {note ? <p className="text-[13px] leading-5 text-warn">{note}</p> : null}
      <ActionError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
