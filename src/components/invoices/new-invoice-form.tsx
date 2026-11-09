"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createInvoiceAction } from "@/app/actions/invoices";
import { Button, Field, Select, TextInput } from "@/components/ui";
import type { ClientChoice, SequenceChoice } from "@/lib/queries/invoices";
import { IDLE_FORM_STATE, listValue } from "./form-state";
import { InvoiceFields } from "./invoice-fields";

const NEW_CLIENT = "__new__";

export function NewInvoiceForm({
  clients,
  currencies,
  sequences,
  defaults,
  profileComplete,
  initialClientId,
}: {
  clients: ClientChoice[];
  currencies: readonly string[];
  sequences: SequenceChoice[];
  defaults: { currency: string; issueDate: string; dueDate: string };
  profileComplete: boolean;
  initialClientId: string | null;
}) {
  const [state, formAction, pending] = useActionState(createInvoiceAction, IDLE_FORM_STATE);
  const values = state.values;

  const firstClient = clients[0];
  const initialChoice = values.clientChoice || (initialClientId && clients.some((c) => c.id === initialClientId) ? initialClientId : firstClient?.id) || NEW_CLIENT;
  const [choice, setChoice] = useState(initialChoice);
  const selected = clients.find((c) => c.id === choice);
  const primaryDefault = selected?.contacts.find((c) => c.isPrimary)?.id ?? selected?.contacts[0]?.id ?? "";
  const [primary, setPrimary] = useState(values.primaryContactId || primaryDefault);
  const [copied, setCopied] = useState<string[]>(listValue(values, "ccContactIds"));

  // After a failed submit the server may switch the form to a client it has just created.
  // Derived during render, so the form follows the server's choice without an effect.
  const [seenChoice, setSeenChoice] = useState(values.clientChoice);
  if (values.clientChoice !== seenChoice) {
    setSeenChoice(values.clientChoice);
    if (values.clientChoice && values.clientChoice !== choice) {
      setChoice(values.clientChoice);
      const c = clients.find((x) => x.id === values.clientChoice);
      setPrimary(values.primaryContactId || c?.contacts.find((x) => x.isPrimary)?.id || "");
      setCopied([]);
    }
  }

  function pickClient(next: string) {
    setChoice(next);
    const c = clients.find((x) => x.id === next);
    setPrimary(c?.contacts.find((x) => x.isPrimary)?.id ?? c?.contacts[0]?.id ?? "");
    setCopied([]);
  }

  function togglePrimary(id: string) {
    setPrimary(id);
    setCopied((prev) => prev.filter((x) => x !== id));
  }

  function toggleCopy(id: string, on: boolean) {
    setCopied((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)));
  }

  const isNew = choice === NEW_CLIENT;
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="grid gap-8" noValidate>
      {!profileComplete ? (
        <p className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-3 text-[14px] leading-6 text-ink-2">
          Reminders wait until your sender profile is complete in{" "}
          <Link href="/settings" className="font-medium text-accent underline underline-offset-4">Settings</Link>. You can add invoices now.
        </p>
      ) : null}

      {state.message ? (
        <p role="alert" className="rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] leading-6 text-danger">
          {state.message}
        </p>
      ) : null}

      <section aria-labelledby="client-heading" className="grid gap-5">
        <h2 id="client-heading" className="text-[16px] font-semibold text-ink">Client</h2>
        <Field id="clientChoice" label="Client" error={errors.clientChoice}>
          <Select id="clientChoice" name="clientChoice" value={choice} onChange={(e) => pickClient(e.currentTarget.value)} aria-invalid={errors.clientChoice ? true : undefined}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {c.email}</option>
            ))}
            <option value={NEW_CLIENT}>New client</option>
          </Select>
        </Field>

        {isNew ? (
          <div className="grid gap-5 rounded-[var(--radius-lg)] border border-line bg-surface-2/60 p-4 sm:grid-cols-2 sm:p-5">
            <Field id="clientName" label="Client name" error={errors.clientName}>
              <TextInput id="clientName" name="clientName" autoComplete="organization" defaultValue={values.clientName ?? ""} aria-invalid={errors.clientName ? true : undefined} maxLength={200} />
            </Field>
            <Field id="clientEmail" label="Client email" hint="Reminders go to this address until you add more contacts." error={errors.clientEmail}>
              <TextInput id="clientEmail" name="clientEmail" type="email" autoComplete="email" inputMode="email" defaultValue={values.clientEmail ?? ""} aria-invalid={errors.clientEmail ? true : undefined} />
            </Field>
          </div>
        ) : null}

        {!isNew && selected ? (
          <fieldset className="grid gap-3">
            <legend className="text-[13px] font-medium text-ink">Who receives reminders</legend>
            <p className="text-[13px] leading-5 text-ink-3">
              Reminders go to the contact you send to. Anyone you copy is included on each reminder. The contact you send to cannot also be copied.
            </p>
            {errors.primaryContactId ? <p role="alert" className="text-[12.5px] text-danger">{errors.primaryContactId}</p> : null}
            <ul className="grid gap-2">
              {selected.contacts.map((ct) => {
                const isPrimary = ct.id === primary;
                const isCopied = copied.includes(ct.id);
                return (
                  <li key={ct.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-ink">{ct.name || ct.email}</p>
                      <p className="truncate text-[13px] text-ink-3">{ct.email}</p>
                    </div>
                    <div className="flex items-center gap-4 text-[13px] text-ink-2">
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input type="radio" name="primaryContactId" value={ct.id} checked={isPrimary} onChange={() => togglePrimary(ct.id)}
                          className="h-4 w-4 accent-[var(--accent)]" />
                        Send to
                      </label>
                      {isPrimary ? null : (
                        <label className="inline-flex cursor-pointer items-center gap-2">
                          <input type="checkbox" name="ccContactIds" value={ct.id} checked={isCopied}
                            onChange={(e) => toggleCopy(ct.id, e.currentTarget.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                          Copy
                        </label>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : null}
      </section>

      <section aria-labelledby="invoice-heading" className="grid gap-5">
        <h2 id="invoice-heading" className="text-[16px] font-semibold text-ink">Invoice</h2>
        <InvoiceFields
          values={values}
          defaults={{ currency: defaults.currency, issueDate: defaults.issueDate, dueDate: defaults.dueDate }}
          errors={errors}
          currencies={currencies}
          sequences={sequences}
        />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Creating…" : "Create invoice"}
        </Button>
        <Link href="/invoices" className="inline-flex h-10 items-center rounded-[10px] px-3 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  );
}
