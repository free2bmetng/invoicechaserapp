"use client";

// The details form, shown in place by the "Details" EditableSection. Closes itself after a save.
// Closed invoices (paid, written off) never render it: their details are read-only.
import { useActionState, useEffect } from "react";
import { updateInvoiceAction } from "@/app/actions/invoices";
import { useEditableSection } from "@/components/data";
import { Button } from "@/components/ui";
import type { SequenceChoice } from "@/lib/queries/invoices";
import { IDLE_FORM_STATE } from "./form-state";
import { InvoiceFields } from "./invoice-fields";

export function InvoiceEditForm({
  invoiceId,
  defaults,
  currencies,
  sequences,
}: {
  invoiceId: string;
  defaults: Record<string, string>;
  currencies: readonly string[];
  sequences: SequenceChoice[];
}) {
  const [state, formAction, pending] = useActionState(updateInvoiceAction, IDLE_FORM_STATE);
  const section = useEditableSection();
  useEffect(() => {
    if (state.ok) section?.close();
  }, [state, section]);
  return (
    <form action={formAction} className="grid gap-6" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <InvoiceFields values={state.values} defaults={defaults} errors={state.fieldErrors} currencies={currencies} sequences={sequences} />
      {state.ok === false && state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}
      <p className="text-small text-ink-3">Changing the due date or the sequence plans the reminders again.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="ghost" data-edit-cancel>Cancel</Button>
      </div>
    </form>
  );
}
