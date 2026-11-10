"use client";

// The edit form inside the client's "Details" section. The client's email is its primary contact's
// address, so it is edited on that contact. It only appears here when the two differ.
import { useActionState, useEffect } from "react";
import { updateClientAction } from "@/app/actions/clients";
import { Button, Field, Select, TextInput } from "@/components/ui";
import { useEditableSection } from "@/components/data";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";
import type { SequenceChoice } from "@/lib/queries/invoices";
import { TIMEZONES } from "./timezones";

export function ClientDetailsForm({
  clientId,
  name,
  email,
  showEmail,
  timezone,
  sequenceId,
  sequences,
  workspaceZone,
}: {
  clientId: string;
  name: string;
  email: string;
  showEmail: boolean;
  timezone: string | null;
  sequenceId: string | null;
  sequences: SequenceChoice[];
  workspaceZone: string;
}) {
  const [state, formAction, pending] = useActionState(updateClientAction, IDLE_FORM_STATE);
  const section = useEditableSection();
  useEffect(() => {
    if (state.ok) section?.close();
    // Close once per successful save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const v = (key: string, fallback: string) => (state.values[key] !== undefined ? state.values[key] : fallback);
  const errors = state.fieldErrors;
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="clientId" value={clientId} />
      <Field id="client-name" label="Name" error={errors.name}>
        <TextInput id="client-name" name="name" defaultValue={v("name", name)} maxLength={200} aria-invalid={errors.name ? true : undefined} />
      </Field>
      {showEmail ? (
        <Field id="client-email" label="Billing email" hint="Different from the primary contact. Saving moves nothing else." error={errors.email}>
          <TextInput id="client-email" name="email" type="email" inputMode="email" defaultValue={v("email", email)} aria-invalid={errors.email ? true : undefined} />
        </Field>
      ) : (
        <input type="hidden" name="email" value={email} />
      )}
      <Field id="client-timezone" label="Timezone" hint="Reminders send in the 9:00–17:00 window of this zone." error={errors.timezone}>
        <Select id="client-timezone" name="timezone" defaultValue={v("timezone", timezone ?? "")} aria-invalid={errors.timezone ? true : undefined}>
          <option value="">Same as mine ({workspaceZone})</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </Select>
      </Field>
      <Field id="client-sequence" label="Sequence" hint="For this client's invoices, unless an invoice picks its own." error={errors.sequenceId}>
        <Select id="client-sequence" name="sequenceId" defaultValue={v("sequenceId", sequenceId ?? "")} aria-invalid={errors.sequenceId ? true : undefined}>
          <option value="">Default sequence</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (default)" : ""}</option>
          ))}
        </Select>
      </Field>
      {state.ok === false && state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save details"}</Button>
        <Button type="button" variant="ghost" data-edit-cancel="">Cancel</Button>
      </div>
    </form>
  );
}
