"use client";

import { useActionState } from "react";
import { setInvoiceContactsAction } from "@/app/actions/invoices";
import { Button } from "@/components/ui";
import { IDLE_FORM_STATE } from "./form-state";

export interface ContactOption {
  id: string;
  name: string;
  email: string;
  hold: string | null;
}

// Uncontrolled inputs keep the form simple: the server returns the saved choice after each submit.
export function ContactsPanel({
  invoiceId,
  contacts,
  primaryId,
  copiedIds,
  locked,
}: {
  invoiceId: string;
  contacts: ContactOption[];
  primaryId: string | null;
  copiedIds: string[];
  locked: boolean;
}) {
  const [state, formAction, pending] = useActionState(setInvoiceContactsAction, IDLE_FORM_STATE);
  const copied = new Set(copiedIds);
  const primaryError = state.fieldErrors.primaryContactId;

  if (contacts.length === 0) {
    return <p className="text-[14px] text-ink-2">This client has no contacts yet. Add one on the client page.</p>;
  }

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <fieldset disabled={locked} className="grid gap-3">
        <legend className="mb-1 text-[13px] font-medium text-ink">Send reminders to</legend>
        <p className="text-[13px] leading-5 text-ink-3">
          Reminders go to the chosen contact. Anyone you copy is included on each reminder.
        </p>
        {primaryError ? <p role="alert" className="text-[12.5px] text-danger">{primaryError}</p> : null}
        <ul className="grid gap-2">
          {contacts.map((ct) => (
            <li key={ct.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">
                  {ct.name || ct.email}
                  {ct.hold === "bounced" ? <span className="ml-2 text-[12px] font-semibold text-danger">Bounced</span> : null}
                </p>
                <p className="truncate text-[13px] text-ink-3">{ct.email}</p>
              </div>
              <div className="flex items-center gap-4 text-[13px] text-ink-2">
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input type="radio" name="primaryContactId" value={ct.id} defaultChecked={ct.id === primaryId} className="h-4 w-4 accent-[var(--accent)]" />
                  Send to
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input type="checkbox" name="ccContactIds" value={ct.id} defaultChecked={copied.has(ct.id)} className="h-4 w-4 accent-[var(--accent)]" />
                  Copy
                </label>
              </div>
            </li>
          ))}
        </ul>
      </fieldset>
      {state.message ? (
        <p role="status" aria-live="polite" className={state.ok ? "text-[13px] text-ink-2" : "text-[13px] text-danger"}>{state.message}</p>
      ) : null}
      <div>
        <Button type="submit" disabled={locked || pending}>{pending ? "Saving…" : "Save contacts"}</Button>
      </div>
    </form>
  );
}
