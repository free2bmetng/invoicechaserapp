"use client";

import { useActionState, startTransition } from "react";
import { removeContactAction, upsertContactAction } from "@/app/actions/clients";
import { Button, Field, TextInput } from "@/components/ui";
import { IDLE_FORM_STATE, type FormState } from "@/components/invoices/form-state";

export interface ContactRowData {
  id: string;
  name: string;
  email: string;
  isPrimary: boolean;
  hold: string | null;
}

export function ContactsEditor({ clientId, contacts }: { clientId: string; contacts: ContactRowData[] }) {
  return (
    <div className="grid gap-4">
      <ul className="grid gap-3">
        {contacts.map((ct) => (
          <ContactRow key={ct.id} clientId={clientId} contact={ct} />
        ))}
      </ul>
      <AddContactForm clientId={clientId} />
    </div>
  );
}

function ContactRow({ clientId, contact }: { clientId: string; contact: ContactRowData }) {
  const [state, dispatch, pending] = useActionState(upsertContactAction, IDLE_FORM_STATE);
  const [removeState, removeDispatch, removePending] = useActionState(removeContactAction, IDLE_FORM_STATE);
  const errors = state.fieldErrors;

  function makePrimary() {
    const payload = new FormData();
    payload.set("clientId", clientId);
    payload.set("contactId", contact.id);
    payload.set("name", contact.name);
    payload.set("email", contact.email);
    payload.set("isPrimary", "on");
    startTransition(() => dispatch(payload));
  }

  function remove() {
    const payload = new FormData();
    payload.set("contactId", contact.id);
    startTransition(() => removeDispatch(payload));
  }

  return (
    <li className="grid gap-4 rounded-[var(--radius-md)] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium text-ink">{contact.name || contact.email}</p>
          {contact.isPrimary ? (
            <span className="rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">Primary</span>
          ) : null}
          {contact.hold === "bounced" ? (
            <span className="rounded-full border border-danger/25 bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger">Bounced · on hold</span>
          ) : null}
          {contact.hold === "paused" ? (
            <span className="rounded-full border border-warn/25 bg-warn-soft px-2 py-0.5 text-[12px] font-semibold text-warn">On hold</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {contact.isPrimary ? null : (
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={makePrimary}>Make primary</Button>
          )}
          {contact.isPrimary ? null : (
            <Button type="button" size="sm" variant="ghost" disabled={removePending} onClick={remove}>Remove</Button>
          )}
        </div>
      </div>

      <form action={dispatch} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" noValidate>
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={contact.id} />
        {contact.isPrimary ? <input type="hidden" name="isPrimary" value="on" /> : null}
        <Field id={`contact-name-${contact.id}`} label="Name" error={errors.name}>
          <TextInput id={`contact-name-${contact.id}`} name="name" defaultValue={state.values.name ?? contact.name} aria-invalid={errors.name ? true : undefined} maxLength={200} />
        </Field>
        <Field id={`contact-email-${contact.id}`} label="Email" error={errors.email}>
          <TextInput id={`contact-email-${contact.id}`} name="email" type="email" inputMode="email" defaultValue={state.values.email ?? contact.email} aria-invalid={errors.email ? true : undefined} />
        </Field>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>{pending ? "Saving…" : "Save contact"}</Button>
      </form>

      {state.message && state.ok === false ? <p role="alert" className="text-[13px] text-danger">{state.message}</p> : null}
      {state.ok === true && state.message ? <p role="status" className="text-[13px] text-ink-2">{state.message}</p> : null}
      {removeState.message && removeState.ok === false ? <p role="alert" className="text-[13px] text-danger">{removeState.message}</p> : null}
    </li>
  );
}

function AddContactForm({ clientId }: { clientId: string }) {
  const [state, formAction, pending] = useActionState(upsertContactAction, IDLE_FORM_STATE);
  const errors = state.fieldErrors;
  return (
    <form action={formAction} className="grid gap-4 rounded-[var(--radius-md)] border border-dashed border-line-strong p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" noValidate>
      <input type="hidden" name="clientId" value={clientId} />
      <Field id="new-contact-name" label="New contact name" error={errors.name}>
        <TextInput id="new-contact-name" name="name" defaultValue={state.values.name ?? ""} maxLength={200} aria-invalid={errors.name ? true : undefined} />
      </Field>
      <Field id="new-contact-email" label="New contact email" error={errors.email}>
        <TextInput id="new-contact-email" name="email" type="email" inputMode="email" defaultValue={state.values.email ?? ""} aria-invalid={errors.email ? true : undefined} />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Adding…" : "Add contact"}</Button>
      {state.message && state.ok === false ? <p role="alert" className="text-[13px] text-danger sm:col-span-3">{state.message}</p> : null}
      {state.ok === true && state.message ? <p role="status" className="text-[13px] text-ink-2 sm:col-span-3">{state.message}</p> : null}
    </form>
  );
}

export type { FormState };
