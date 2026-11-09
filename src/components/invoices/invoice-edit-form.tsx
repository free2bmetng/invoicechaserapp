"use client";

import { useActionState } from "react";
import { updateInvoiceAction } from "@/app/actions/invoices";
import { Button } from "@/components/ui";
import type { SequenceChoice } from "@/lib/queries/invoices";
import { IDLE_FORM_STATE } from "./form-state";
import { InvoiceFields } from "./invoice-fields";

export function InvoiceEditForm({
  invoiceId,
  defaults,
  currencies,
  sequences,
  locked,
  lockedReason,
}: {
  invoiceId: string;
  defaults: Record<string, string>;
  currencies: readonly string[];
  sequences: SequenceChoice[];
  locked: boolean;
  lockedReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateInvoiceAction, IDLE_FORM_STATE);
  return (
    <form action={formAction} className="grid gap-6" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {locked && lockedReason ? (
        <p className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-3 text-[14px] leading-6 text-ink-2">{lockedReason}</p>
      ) : null}
      <fieldset disabled={locked} className="grid gap-6">
        <InvoiceFields
          values={state.values}
          defaults={defaults}
          errors={state.fieldErrors}
          currencies={currencies}
          sequences={sequences}
          disabled={locked}
          amountHint="Like 1234.50. No commas."
        />
      </fieldset>
      {state.message ? (
        <p role="status" aria-live="polite" className={state.ok ? "text-[13px] text-ink-2" : "text-[13px] text-danger"}>{state.message}</p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={locked || pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
