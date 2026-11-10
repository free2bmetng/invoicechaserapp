"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createClientAction } from "@/app/actions/clients";
import { Button, Field, Switch, TextInput, buttonClass } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

// Opened from "Add client" in the clients header. Success redirects to the new client's page.
// `cancelHref` is null when there are no clients yet, because then the form is the page.
export function AddClientForm({ cancelHref }: { cancelHref?: string | null }) {
  const [state, formAction, pending] = useActionState(createClientAction, IDLE_FORM_STATE);
  const errors = state.fieldErrors;
  return (
    <form action={formAction} className="grid max-w-3xl gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        <Field id="new-client-name" label="Client name" error={errors.name}>
          <TextInput id="new-client-name" name="name" autoComplete="organization" autoFocus width="full"
            defaultValue={state.values.name ?? ""} aria-invalid={errors.name ? true : undefined} maxLength={200} />
        </Field>
        <Field id="new-client-email" label="Billing email" hint="Reminders go here. You can add more contacts later." error={errors.email}>
          <TextInput id="new-client-email" name="email" type="email" inputMode="email" autoComplete="email" width="full"
            defaultValue={state.values.email ?? ""} aria-invalid={errors.email ? true : undefined} />
        </Field>
      </div>
      <div className="border-t border-line pt-1">
        <Switch id="new-client-autosend" name="autoSend" label="Send the first reminder without approval"
          description="Off: the first reminder waits in Needs you. Steps marked for approval always wait." />
      </div>
      {state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Adding…" : "Add client"}</Button>
        {cancelHref ? <Link href={cancelHref} scroll={false} className={buttonClass("ghost")}>Cancel</Link> : null}
      </div>
    </form>
  );
}
