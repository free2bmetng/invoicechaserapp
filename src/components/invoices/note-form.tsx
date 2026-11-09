"use client";

// The note composer at the top of the activity timeline. A note is saved as an event, so it
// appears in the history at once. The field clears after a successful save.
import { useActionState, useState } from "react";
import { addInvoiceNoteAction } from "@/app/actions/invoices";
import { Button, cx } from "@/components/ui";
import { IDLE_FORM_STATE } from "./form-state";

export function NoteForm({ invoiceId, placeholder }: { invoiceId: string; placeholder: string }) {
  const [state, formAction, pending] = useActionState(addInvoiceNoteAction, IDLE_FORM_STATE);
  const [text, setText] = useState("");
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.ok) setText("");
  }
  const error = state.fieldErrors.note ?? (state.ok === false ? state.message : null);
  return (
    <form action={formAction} className="grid gap-2" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <label htmlFor="invoice-note" className="sr-only">Note</label>
      <div
        className={cx(
          "flex flex-col gap-2 rounded-[12px] border bg-surface p-2 transition-colors focus-within:border-accent sm:flex-row sm:items-end",
          error ? "border-danger" : "border-line-strong",
        )}
      >
        <textarea
          id="invoice-note"
          name="note"
          rows={text.includes("\n") ? 3 : 1}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "invoice-note-error" : undefined}
          className="min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pending || text.trim() === ""} className="shrink-0">
          {pending ? "Saving…" : "Add note"}
        </Button>
      </div>
      {error ? (
        <p id="invoice-note-error" role="alert" className="text-[12.5px] text-danger">{error}</p>
      ) : state.ok && state.message ? (
        <p role="status" className="text-[12.5px] text-ink-3">{state.message}</p>
      ) : null}
    </form>
  );
}
