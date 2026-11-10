"use client";

// The client's contacts as rows. Each row reads as text, with Edit opening a small form in the row
// itself, one row at a time. "Add contact" opens a blank row at the end. Make primary and Remove act
// at once, because they are structural changes, not edits.
import { startTransition, useActionState, useCallback, useEffect, useRef, useState } from "react";
import { removeContactAction, upsertContactAction } from "@/app/actions/clients";
import { Badge, Button, Card, Field, TextInput, cx } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

export interface ContactRowData {
  id: string;
  name: string;
  email: string;
  isPrimary: boolean;
  hold: string | null;
}

function ContactForm({
  clientId,
  contact,
  onDone,
}: {
  clientId: string;
  contact: ContactRowData | null;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(upsertContactAction, IDLE_FORM_STATE);
  const errors = state.fieldErrors;
  const key = contact?.id ?? "new";
  useEffect(() => {
    if (state.ok) onDone();
  }, [state, onDone]);
  return (
    <form
      action={formAction}
      noValidate
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
      className="grid gap-3 bg-surface-2/60 px-4 py-4 sm:px-6"
    >
      <input type="hidden" name="clientId" value={clientId} />
      {contact ? <input type="hidden" name="contactId" value={contact.id} /> : null}
      {contact?.isPrimary ? <input type="hidden" name="isPrimary" value="on" /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`contact-name-${key}`} label="Name" error={errors.name}>
          <TextInput id={`contact-name-${key}`} name="name" width="full" autoFocus maxLength={200} placeholder="Optional"
            defaultValue={state.values.name ?? contact?.name ?? ""} aria-invalid={errors.name ? true : undefined} />
        </Field>
        <Field id={`contact-email-${key}`} label="Email" error={errors.email}>
          <TextInput id={`contact-email-${key}`} name="email" type="email" inputMode="email" width="full"
            defaultValue={state.values.email ?? contact?.email ?? ""} aria-invalid={errors.email ? true : undefined} />
        </Field>
      </div>
      {contact?.isPrimary ? (
        <p className="text-small text-ink-3">This is the primary contact. Its address is the client&apos;s email, so changing it changes both.</p>
      ) : null}
      {state.ok === false && state.message && !errors.email && !errors.name ? (
        <p role="alert" className="text-small text-danger">{state.message}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Saving…" : contact ? "Save contact" : "Add contact"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function ContactList({ clientId, contacts }: { clientId: string; contacts: ContactRowData[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [makeState, makeDispatch, makePending] = useActionState(upsertContactAction, IDLE_FORM_STATE);
  const [removeState, removeDispatch, removePending] = useActionState(removeContactAction, IDLE_FORM_STATE);
  const addButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setEditing(null), []);
  const closeNew = useCallback(() => {
    setEditing(null);
    requestAnimationFrame(() => addButton.current?.focus());
  }, []);

  function makePrimary(ct: ContactRowData) {
    const payload = new FormData();
    payload.set("clientId", clientId);
    payload.set("contactId", ct.id);
    payload.set("name", ct.name);
    payload.set("email", ct.email);
    payload.set("isPrimary", "on");
    startTransition(() => makeDispatch(payload));
  }

  function remove(ct: ContactRowData) {
    const payload = new FormData();
    payload.set("contactId", ct.id);
    startTransition(() => removeDispatch(payload));
  }

  const note = [makeState, removeState].find((s) => s.message);
  const ordered = [...contacts].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  return (
    <Card className="overflow-hidden" as="section">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
        <div className="min-w-0">
          <h2 id="contacts-heading" className="text-card-title text-ink">Contacts</h2>
          <p className="mt-0.5 text-small text-ink-3">Every reminder goes to all of these addresses.</p>
        </div>
        {editing === "new" ? null : (
          <Button ref={addButton} type="button" size="sm" className="-my-1.5 shrink-0" onClick={() => setEditing("new")}>Add contact</Button>
        )}
      </div>
      <ul aria-labelledby="contacts-heading" className="border-t border-line">
        {ordered.map((ct) => (
          <li key={ct.id} className="border-b border-line last:border-b-0">
            {editing === ct.id ? (
              <ContactForm clientId={clientId} contact={ct} onDone={close} />
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-body">
                    <span className="truncate font-medium text-ink">{ct.name || ct.email}</span>
                    {ct.isPrimary ? <Badge tone="accent">Primary</Badge> : null}
                    {ct.hold === "bounced" ? <Badge tone="danger">Bounced</Badge> : null}
                    {ct.hold === "paused" ? <Badge tone="warn">On hold</Badge> : null}
                  </p>
                  {ct.name ? <p className="truncate text-small text-ink-2">{ct.email}</p> : null}
                </div>
                <div className={cx("flex shrink-0 items-center gap-1")}>
                  {ct.isPrimary ? null : (
                    <>
                      <Button type="button" variant="ghost" size="sm" disabled={makePending} onClick={() => makePrimary(ct)}>Make primary</Button>
                      <Button type="button" variant="ghost" size="sm" disabled={removePending} onClick={() => remove(ct)}
                        aria-label={`Remove ${ct.name || ct.email}`}>Remove</Button>
                    </>
                  )}
                  <Button type="button" size="sm" onClick={() => setEditing(ct.id)} aria-label={`Edit ${ct.name || ct.email}`}>Edit</Button>
                </div>
              </div>
            )}
          </li>
        ))}
        {editing === "new" ? (
          <li className="border-t border-line">
            <ContactForm clientId={clientId} contact={null} onDone={closeNew} />
          </li>
        ) : null}
      </ul>
      {note?.message ? (
        <p role={note.ok === false ? "alert" : "status"} className={cx("border-t border-line px-4 py-3 text-small sm:px-6", note.ok === false ? "text-danger" : "text-ink-2")}>
          {note.message}
        </p>
      ) : null}
    </Card>
  );
}
