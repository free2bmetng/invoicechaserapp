"use client";

import { useActionState } from "react";
import { updateClientAction } from "@/app/actions/clients";
import { Button, Field, Select, TextInput } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";
import type { SequenceChoice } from "@/lib/queries/invoices";
import { TIMEZONES } from "./timezones";

export function ClientDetailsForm({
  clientId,
  name,
  email,
  timezone,
  sequenceId,
  sequences,
  workspaceZone,
}: {
  clientId: string;
  name: string;
  email: string;
  timezone: string | null;
  sequenceId: string | null;
  sequences: SequenceChoice[];
  workspaceZone: string;
}) {
  const [state, formAction, pending] = useActionState(updateClientAction, IDLE_FORM_STATE);
  const v = (key: string, fallback: string) => (state.values[key] !== undefined ? state.values[key] : fallback);
  const errors = state.fieldErrors;
  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="clientId" value={clientId} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="client-name" label="Name" error={errors.name}>
          <TextInput id="client-name" name="name" defaultValue={v("name", name)} aria-invalid={errors.name ? true : undefined} maxLength={200} />
        </Field>
        <Field id="client-email" label="Email" hint="Changing it also moves the primary contact's address." error={errors.email}>
          <TextInput id="client-email" name="email" type="email" inputMode="email" defaultValue={v("email", email)} aria-invalid={errors.email ? true : undefined} />
        </Field>
      </div>
      <div className="grid gap-5">
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
      {state.message ? (
        <p role="status" aria-live="polite" className={state.ok ? "text-[13px] text-ink-2" : "text-[13px] text-danger"}>{state.message}</p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save details"}</Button>
      </div>
    </form>
  );
}
