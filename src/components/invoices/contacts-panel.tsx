"use client";

// Who gets the reminders, edited in place by the "Reminders go to" EditableSection.
// Each choice is a full 44px row. Closes itself after a save.
import { useActionState, useEffect, useState } from "react";
import { setInvoiceContactsAction } from "@/app/actions/invoices";
import { useEditableSection } from "@/components/data";
import { Badge, Button } from "@/components/ui";
import { IDLE_FORM_STATE } from "./form-state";

export interface ContactOption {
  id: string;
  name: string;
  email: string;
  hold: string | null;
}

export function ContactsPanel({
  invoiceId,
  contacts,
  primaryId,
  copiedIds,
}: {
  invoiceId: string;
  contacts: ContactOption[];
  primaryId: string | null;
  copiedIds: string[];
}) {
  const [state, formAction, pending] = useActionState(setInvoiceContactsAction, IDLE_FORM_STATE);
  const section = useEditableSection();
  const [primary, setPrimary] = useState(primaryId ?? "");
  const [copied, setCopied] = useState<string[]>(copiedIds.filter((id) => id !== primaryId));
  useEffect(() => {
    if (state.ok) section?.close();
  }, [state, section]);
  const primaryError = state.fieldErrors.primaryContactId;

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-small text-ink-3">Choose who each reminder is sent to. Anyone copied in gets every reminder too.</legend>
        {primaryError ? <p role="alert" className="text-[12.5px] text-danger">{primaryError}</p> : null}
        <ul className="divide-y divide-line rounded-[var(--radius-md)] border border-line">
          {contacts.map((ct) => {
            const isPrimary = ct.id === primary;
            return (
              <li key={ct.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-1">
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="radio"
                    name="primaryContactId"
                    value={ct.id}
                    checked={isPrimary}
                    onChange={() => {
                      setPrimary(ct.id);
                      setCopied((prev) => prev.filter((x) => x !== ct.id));
                    }}
                    className="size-[18px] shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 truncate text-body font-medium text-ink">
                      {ct.name || ct.email}
                      {ct.hold === "bounced" ? <Badge tone="danger">Bounced</Badge> : ct.hold ? <Badge>On hold</Badge> : null}
                    </span>
                    {ct.name ? <span className="block truncate text-small text-ink-3">{ct.email}</span> : null}
                  </span>
                </label>
                {isPrimary ? (
                  <span className="px-2 text-small text-ink-3">Sent to</span>
                ) : (
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[8px] px-2 text-small text-ink-2 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      name="ccContactIds"
                      value={ct.id}
                      checked={copied.includes(ct.id)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setCopied((prev) => (on ? [...prev.filter((x) => x !== ct.id), ct.id] : prev.filter((x) => x !== ct.id)));
                      }}
                      className="size-[18px] accent-[var(--accent)]"
                    />
                    Copy in
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      {state.ok === false && state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="ghost" data-edit-cancel>Cancel</Button>
      </div>
    </form>
  );
}
