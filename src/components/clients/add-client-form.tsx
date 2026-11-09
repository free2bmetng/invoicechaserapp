"use client";

import { useActionState } from "react";
import { createClientAction } from "@/app/actions/clients";
import { Button, Field, Switch, TextInput } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

// Used on the clients list. Success redirects to the new client's page.
export function AddClientForm() {
  const [state, formAction, pending] = useActionState(createClientAction, IDLE_FORM_STATE);
  const errors = state.fieldErrors;
  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="new-client-name" label="Client name" error={errors.name}>
          <TextInput id="new-client-name" name="name" autoComplete="organization" defaultValue={state.values.name ?? ""} aria-invalid={errors.name ? true : undefined} maxLength={200} />
        </Field>
        <Field id="new-client-email" label="Client email" hint="Reminders go to this address until you add more contacts." error={errors.email}>
          <TextInput id="new-client-email" name="email" type="email" inputMode="email" autoComplete="email" defaultValue={state.values.email ?? ""} aria-invalid={errors.email ? true : undefined} />
        </Field>
      </div>
      <Switch id="new-client-autosend" name="autoSend" label="Send the first reminder without approval" description="Off by default. The first reminder to a new client waits for your approval unless this is on. Reminders marked for approval always wait." />
      {state.message ? <p role="alert" className="text-[13px] text-danger">{state.message}</p> : null}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Adding…" : "Add client"}</Button>
      </div>
    </form>
  );
}
