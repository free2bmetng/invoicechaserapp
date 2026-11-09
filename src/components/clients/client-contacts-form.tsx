"use client";

// The contact block: the client's details, every contact, and an optional new contact, saved together
// with one Save. Make primary and Remove act at once, because they are structural changes, not edits.
import { startTransition, useActionState } from "react";
import { removeContactAction, saveClientContactsAction, upsertContactAction } from "@/app/actions/clients";
import { Button, Field, Select, TextInput } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";
import type { SequenceChoice } from "@/lib/queries/invoices";
import { TIMEZONES } from "./timezones";

export interface ContactFormRow {
  id: string;
  name: string;
  email: string;
  isPrimary: boolean;
  hold: string | null;
}

export function ClientContactsForm({
  clientId,
  name,
  email,
  timezone,
  sequenceId,
  sequences,
  workspaceZone,
  contacts,
}: {
  clientId: string;
  name: string;
  email: string;
  timezone: string | null;
  sequenceId: string | null;
  sequences: SequenceChoice[];
  workspaceZone: string;
  contacts: ContactFormRow[];
}) {
  const [state, formAction, pending] = useActionState(saveClientContactsAction, IDLE_FORM_STATE);
  const [makeState, makeDispatch] = useActionState(upsertContactAction, IDLE_FORM_STATE);
  const [removeState, removeDispatch] = useActionState(removeContactAction, IDLE_FORM_STATE);
  const primary = contacts.find((c) => c.isPrimary) ?? null;
  const v = (key: string, fallback: string) => (state.values[key] !== undefined ? state.values[key] : fallback);
  const errors = state.fieldErrors;

  function makePrimary(ct: ContactFormRow) {
    const payload = new FormData();
    payload.set("clientId", clientId);
    payload.set("contactId", ct.id);
    payload.set("name", ct.name);
    payload.set("email", ct.email);
    payload.set("isPrimary", "on");
    startTransition(() => makeDispatch(payload));
  }

  function remove(ct: ContactFormRow) {
    const payload = new FormData();
    payload.set("contactId", ct.id);
    startTransition(() => removeDispatch(payload));
  }

  return (
    <form action={formAction} className="grid gap-8" noValidate>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="primaryId" value={primary?.id ?? ""} />

      <div className="grid gap-5">
        <h3 className="text-[14px] font-semibold text-ink">Client</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="client-name" label="Name" error={errors.name}>
            <TextInput id="client-name" name="name" defaultValue={v("name", name)} aria-invalid={errors.name ? true : undefined} maxLength={200} />
          </Field>
          <Field id="client-email" label="Email" hint="Changing it also moves the primary contact's address." error={errors.email}>
            <TextInput id="client-email" name="email" type="email" inputMode="email" defaultValue={v("email", email)} aria-invalid={errors.email ? true : undefined} />
          </Field>
        </div>
        <Field id="client-timezone" label="Timezone" hint={`Send window and dates use this zone. Leave on your own timezone (${workspaceZone}) to follow your settings.`} error={errors.timezone}>
          <Select id="client-timezone" name="timezone" defaultValue={v("timezone", timezone ?? "")} aria-invalid={errors.timezone ? true : undefined}>
            <option value="">Use my timezone ({workspaceZone})</option>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
        <Field id="client-sequence" label="Sequence" hint="Used for this client's open invoices unless an invoice chooses its own." error={errors.sequenceId}>
          <Select id="client-sequence" name="sequenceId" defaultValue={v("sequenceId", sequenceId ?? "")} aria-invalid={errors.sequenceId ? true : undefined}>
            <option value="">Default sequence</option>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (default)" : ""}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-4">
        <h3 className="text-[14px] font-semibold text-ink">Contacts</h3>
        {contacts.length === 0 ? <p className="text-[14px] text-ink-2">No contacts yet. Add one below.</p> : null}
        <ul className="grid gap-3">
          {contacts.map((ct) => {
            const nameKey = `contactName_${ct.id}`;
            const emailKey = `contactEmail_${ct.id}`;
            return (
              <li key={ct.id} className="grid gap-4 rounded-[var(--radius-md)] border border-line bg-surface p-4">
                <input type="hidden" name="contactId" value={ct.id} />
                <input type="hidden" name={`originalName_${ct.id}`} value={ct.name} />
                <input type="hidden" name={`originalEmail_${ct.id}`} value={ct.email} />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {ct.isPrimary ? (
                      <span className="rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">Primary</span>
                    ) : null}
                    {ct.hold === "bounced" ? (
                      <span className="rounded-full border border-danger/25 bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger">Bounced · on hold</span>
                    ) : null}
                    {ct.hold === "paused" ? (
                      <span className="rounded-full border border-warn/25 bg-warn-soft px-2 py-0.5 text-[12px] font-semibold text-warn">On hold</span>
                    ) : null}
                  </div>
                  {ct.isPrimary ? null : (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="secondary" className="min-h-11 sm:min-h-8" onClick={() => makePrimary(ct)}>Make primary</Button>
                      <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => remove(ct)}>Remove</Button>
                    </div>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={`contact-name-${ct.id}`} label="Contact name" error={errors[nameKey]}>
                    <TextInput id={`contact-name-${ct.id}`} name={nameKey} defaultValue={v(nameKey, ct.name)} maxLength={200} aria-invalid={errors[nameKey] ? true : undefined} />
                  </Field>
                  <Field id={`contact-email-${ct.id}`} label="Contact email" error={errors[emailKey]}>
                    <TextInput id={`contact-email-${ct.id}`} name={emailKey} type="email" inputMode="email" defaultValue={v(emailKey, ct.email)} aria-invalid={errors[emailKey] ? true : undefined} />
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="grid gap-4 rounded-[var(--radius-md)] border border-dashed border-line-strong p-4 sm:grid-cols-2">
          <p className="text-[13px] font-medium text-ink sm:col-span-2">Add a contact (optional)</p>
          <Field id="new-contact-name" label="New contact name" error={errors.newContactName}>
            <TextInput id="new-contact-name" name="newContactName" defaultValue={v("newContactName", "")} maxLength={200} />
          </Field>
          <Field id="new-contact-email" label="New contact email" error={errors.newContactEmail}>
            <TextInput id="new-contact-email" name="newContactEmail" type="email" inputMode="email" defaultValue={v("newContactEmail", "")} aria-invalid={errors.newContactEmail ? true : undefined} />
          </Field>
        </div>
      </div>

      <div className="grid gap-2">
        {state.message ? (
          <p role={state.ok === false ? "alert" : "status"} aria-live="polite" className={state.ok === false ? "text-[13px] text-danger" : "text-[13px] text-ink-2"}>{state.message}</p>
        ) : null}
        {makeState.message && makeState.ok === false ? <p role="alert" className="text-[13px] text-danger">{makeState.message}</p> : null}
        {removeState.message && removeState.ok === false ? <p role="alert" className="text-[13px] text-danger">{removeState.message}</p> : null}
        {makeState.ok === true && makeState.message ? <p role="status" className="text-[13px] text-ink-2">{makeState.message}</p> : null}
        {removeState.ok === true && removeState.message ? <p role="status" className="text-[13px] text-ink-2">{removeState.message}</p> : null}
      </div>

      <div>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}
