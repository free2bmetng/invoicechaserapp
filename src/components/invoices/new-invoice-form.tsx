"use client";

// The new-invoice form. Ordered by importance: who it is for, then the money and dates, then
// the rarely changed options behind "More options". Currency and payment terms default from the
// chosen client's last invoice. A preview of the first reminder sits beside the form on desktop.
import Link from "next/link";
import { useActionState, useState } from "react";
import { createInvoiceAction } from "@/app/actions/invoices";
import { Button, Card, Field, Select, Textarea, TextInput, cx } from "@/components/ui";
import type { ClientChoice, ClientInvoiceDefaults, SequenceChoice } from "@/lib/queries/invoices";
import { IDLE_FORM_STATE, listValue } from "./form-state";
import { AmountInput } from "./amount-input";
import { addDaysIso, daysBetween } from "./format";
import { parseTypedMoney } from "./money-input";
import { ReminderPreview, type PreviewSequence } from "./reminder-preview";

const NEW_CLIENT = "__new__";
const DEFAULT_TERMS = 14;
const TERM_CHOICES = [7, 14, 30, 60];

export function NewInvoiceForm({
  clients,
  currencies,
  sequences,
  previewSequences,
  defaultSequenceId,
  clientDefaults,
  defaults,
  today,
  sender,
  profileComplete,
  initialClientId,
}: {
  clients: ClientChoice[];
  currencies: readonly string[];
  sequences: SequenceChoice[];
  previewSequences: PreviewSequence[];
  defaultSequenceId: string | null;
  clientDefaults: Record<string, ClientInvoiceDefaults>;
  defaults: { currency: string; issueDate: string };
  today: string;
  sender: { senderName: string; businessName: string };
  profileComplete: boolean;
  initialClientId: string | null;
}) {
  const [state, formAction, pending] = useActionState(createInvoiceAction, IDLE_FORM_STATE);
  const values = state.values;
  const errors = state.fieldErrors;

  const initialChoice =
    values.clientChoice ||
    (initialClientId && clients.some((c) => c.id === initialClientId) ? initialClientId : clients[0]?.id) ||
    NEW_CLIENT;
  const termsFor = (clientId: string) => clientDefaults[clientId]?.termsDays ?? DEFAULT_TERMS;
  const currencyFor = (clientId: string) => clientDefaults[clientId]?.currency ?? defaults.currency;

  const [choice, setChoice] = useState(initialChoice);
  const selected = clients.find((c) => c.id === choice);
  const primaryDefault = selected?.contacts.find((c) => c.isPrimary)?.id ?? selected?.contacts[0]?.id ?? "";
  const [primary, setPrimary] = useState(values.primaryContactId || primaryDefault);
  const [copied, setCopied] = useState<string[]>(listValue(values, "ccContactIds"));
  const [currency, setCurrency] = useState(values.currency || currencyFor(initialChoice));
  const [amount, setAmount] = useState(values.amount ?? "");
  const [invoiceNumber, setInvoiceNumber] = useState(values.invoiceNumber ?? "");
  const [issueDate, setIssueDate] = useState(values.issueDate || defaults.issueDate);
  const [dueDate, setDueDate] = useState(values.dueDate || addDaysIso(defaults.issueDate, termsFor(initialChoice)));
  const [sequenceId, setSequenceId] = useState(values.sequenceId ?? "");
  // Once the user picks a currency or a due date, a later client change leaves it alone.
  const [currencyTouched, setCurrencyTouched] = useState(Boolean(values.currency));
  const [dueTouched, setDueTouched] = useState(Boolean(values.dueDate));
  const [newClientName, setNewClientName] = useState(values.clientName ?? "");

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
    if (!currencyTouched) setCurrency(currencyFor(next));
    if (!dueTouched && issueDate) setDueDate(addDaysIso(issueDate, termsFor(next)));
  }

  function changeIssue(next: string) {
    // Keep the same terms when the issue date moves.
    if (/^\d{4}-\d{2}-\d{2}$/.test(next) && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setDueDate(addDaysIso(next, Math.max(0, daysBetween(issueDate, dueDate))));
    }
    setIssueDate(next);
  }

  const isNew = choice === NEW_CLIENT;
  const clientDefault = selected ? clientDefaults[selected.id] : undefined;
  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(issueDate) && /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const terms = validDates ? daysBetween(issueDate, dueDate) : null;

  let amountMinor: number | null = null;
  try {
    amountMinor = amount.trim() ? parseTypedMoney(amount, currency) : null;
  } catch {
    amountMinor = null;
  }

  const sequenceForPreview =
    previewSequences.find((s) => s.id === (sequenceId || selected?.sequenceId || defaultSequenceId)) ??
    previewSequences.find((s) => s.id === defaultSequenceId) ??
    null;
  const recipient = isNew ? "" : (selected?.contacts.find((c) => c.id === primary)?.email ?? "");

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:gap-8">
      <form action={formAction} className="grid min-w-0 gap-6" noValidate>
        {!profileComplete ? (
          <p className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-3 text-body text-ink-2">
            Reminders wait until your sender profile is complete in{" "}
            <Link href="/settings" className="font-medium text-accent underline underline-offset-4">Settings</Link>. You can add invoices now.
          </p>
        ) : null}

        {state.message ? (
          <p role="alert" className="rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-body text-danger">
            {state.message}
          </p>
        ) : null}

        <Card as="section" className="grid gap-5 p-4 sm:p-6">
          <h2 className="text-section-title text-ink">Client</h2>
          <Field id="clientChoice" label="Who is this invoice for?" error={errors.clientChoice}>
            <Select id="clientChoice" name="clientChoice" value={choice} onChange={(e) => pickClient(e.currentTarget.value)} aria-invalid={errors.clientChoice ? true : undefined}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value={NEW_CLIENT}>+ New client</option>
            </Select>
          </Field>

          {isNew ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="clientName" label="Client name" error={errors.clientName}>
                <TextInput id="clientName" name="clientName" autoComplete="organization" value={newClientName} onChange={(e) => setNewClientName(e.currentTarget.value)}
                  aria-invalid={errors.clientName ? true : undefined} maxLength={200} width="full" />
              </Field>
              <Field id="clientEmail" label="Client email" hint="Reminders go to this address." error={errors.clientEmail}>
                <TextInput id="clientEmail" name="clientEmail" type="email" autoComplete="email" inputMode="email" defaultValue={values.clientEmail ?? ""}
                  aria-invalid={errors.clientEmail ? true : undefined} width="full" />
              </Field>
            </div>
          ) : null}

          {!isNew && selected ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[13px] font-medium text-ink">Reminders go to</legend>
              {errors.primaryContactId ? <p role="alert" className="text-[12.5px] text-danger">{errors.primaryContactId}</p> : null}
              <ul className="grid max-w-xl divide-y divide-line rounded-[var(--radius-md)] border border-line">
                {selected.contacts.map((ct) => {
                  const isPrimary = ct.id === primary;
                  const isCopied = copied.includes(ct.id);
                  return (
                    <li key={ct.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-1">
                      <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input type="radio" name="primaryContactId" value={ct.id} checked={isPrimary}
                          onChange={() => { setPrimary(ct.id); setCopied((prev) => prev.filter((x) => x !== ct.id)); }}
                          className="size-[18px] shrink-0 accent-[var(--accent)]" />
                        <span className="min-w-0">
                          <span className="block truncate text-body font-medium text-ink">{ct.name || ct.email}</span>
                          {ct.name ? <span className="block truncate text-small text-ink-3">{ct.email}</span> : null}
                        </span>
                      </label>
                      {isPrimary ? (
                        <span className="px-2 text-small text-ink-3">Sent to</span>
                      ) : (
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[8px] px-2 text-small text-ink-2 hover:bg-surface-2">
                          <input type="checkbox" name="ccContactIds" value={ct.id} checked={isCopied}
                            onChange={(e) => { const on = e.currentTarget.checked; setCopied((prev) => (on ? [...prev.filter((x) => x !== ct.id), ct.id] : prev.filter((x) => x !== ct.id))); }}
                            className="size-[18px] accent-[var(--accent)]" />
                          Copy in
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}
        </Card>

        <Card as="section" className="grid gap-5 p-4 sm:p-6">
          <h2 className="text-section-title text-ink">Amount and dates</h2>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <Field id="invoiceNumber" label="Invoice number" error={errors.invoiceNumber}>
              <TextInput id="invoiceNumber" name="invoiceNumber" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.currentTarget.value)}
                aria-invalid={errors.invoiceNumber ? true : undefined} autoComplete="off" maxLength={64} width="full" />
            </Field>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="amount" className="text-[13px] font-medium text-ink">Amount</label>
              <div className="flex max-w-sm">
                <label htmlFor="currency" className="sr-only">Currency</label>
                <div className="w-[6.25rem] shrink-0">
                  <Select id="currency" name="currency" value={currency} width="full"
                    onChange={(e) => { setCurrency(e.currentTarget.value); setCurrencyTouched(true); }}
                    aria-invalid={errors.currency ? true : undefined}
                    className="rounded-r-none font-medium">
                    {currencies.map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </Select>
                </div>
                <div className="-ml-px min-w-0 flex-1">
                  <AmountInput id="amount" name="amount" value={amount} currency={currency} onValueChange={setAmount}
                    aria-invalid={errors.amount ? true : undefined} aria-describedby={errors.amount ? "amount-error" : clientDefault ? "currency-hint" : undefined}
                    placeholder="0.00" className="rounded-l-none text-right text-[16px] font-medium" />
                </div>
              </div>
              {errors.amount || errors.currency ? (
                <p id="amount-error" role="alert" className="text-[12.5px] leading-5 text-danger">{errors.amount ?? errors.currency}</p>
              ) : clientDefault && !currencyTouched && selected ? (
                <p id="currency-hint" className="text-[12.5px] leading-5 text-ink-3">{clientDefault.currency}, as on {selected.name}&apos;s last invoice.</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <Field id="issueDate" label="Issue date" error={errors.issueDate}>
              <TextInput id="issueDate" name="issueDate" type="date" value={issueDate} onChange={(e) => changeIssue(e.currentTarget.value)}
                aria-invalid={errors.issueDate ? true : undefined} width="full" />
            </Field>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dueDate" className="text-[13px] font-medium text-ink">Due date</label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-[11.5rem]">
                  <TextInput id="dueDate" name="dueDate" type="date" value={dueDate}
                    onChange={(e) => { setDueDate(e.currentTarget.value); setDueTouched(true); }}
                    aria-invalid={errors.dueDate ? true : undefined} aria-describedby="due-hint" width="full" />
                </div>
                <div role="group" aria-label="Payment terms" className="flex gap-1">
                  {TERM_CHOICES.map((days) => (
                    <button key={days} type="button" aria-pressed={terms === days}
                      onClick={() => { if (/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) { setDueDate(addDaysIso(issueDate, days)); setDueTouched(true); } }}
                      className={cx(
                        "num h-11 rounded-[8px] border px-2.5 text-[13px] font-medium transition-colors sm:h-9",
                        terms === days ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-2 hover:border-line-strong hover:text-ink",
                      )}>
                      {days}d
                    </button>
                  ))}
                </div>
              </div>
              {errors.dueDate ? (
                <p id="due-hint" role="alert" className="text-[12.5px] leading-5 text-danger">{errors.dueDate}</p>
              ) : (
                <p id="due-hint" className="text-[12.5px] leading-5 text-ink-3">
                  {terms !== null && terms >= 0 ? `${terms === 0 ? "Due on issue" : `${terms} days after the issue date`}` : "Reminders are planned from this date."}
                  {terms !== null && clientDefault && !dueTouched && selected ? `, ${selected.name}'s usual terms.` : terms !== null && terms >= 0 ? "." : ""}
                </p>
              )}
            </div>
          </div>

          <details className="group rounded-[var(--radius-md)] border border-line" open={Boolean(errors.sequenceId || errors.notes) || undefined}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-body font-medium text-ink [&::-webkit-details-marker]:hidden">
              <span>
                More options
                <span className="ml-2 font-normal text-ink-3">Sequence and notes</span>
              </span>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="text-ink-3 transition-transform group-open:rotate-180">
                <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="grid gap-5 border-t border-line px-4 py-4">
              <Field id="sequenceId" label="Reminder sequence" error={errors.sequenceId}>
                <Select id="sequenceId" name="sequenceId" value={sequenceId} onChange={(e) => setSequenceId(e.currentTarget.value)} aria-invalid={errors.sequenceId ? true : undefined}>
                  <option value="">{selected?.sequenceId ? "The client's sequence" : "The default sequence"}</option>
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (default)" : ""}</option>
                  ))}
                </Select>
              </Field>
              <Field id="notes" label="Notes" hint="Only you see these. They are never sent to the client." error={errors.notes}>
                <Textarea id="notes" name="notes" defaultValue={values.notes ?? ""} aria-invalid={errors.notes ? true : undefined} className="min-h-[88px]" />
              </Field>
            </div>
          </details>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creating…" : "Create invoice"}
          </Button>
          <Link href="/invoices" className="inline-flex h-11 items-center rounded-[10px] px-4 text-[14px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink sm:h-10">
            Cancel
          </Link>
        </div>
      </form>

      <aside className="hidden lg:sticky lg:top-6 lg:block" aria-label="Reminder preview">
        <ReminderPreview
          sequence={sequenceForPreview}
          today={today}
          dueDate={dueDate}
          amountMinor={amountMinor}
          currency={currency}
          invoiceNumber={invoiceNumber}
          clientName={isNew ? newClientName : (selected?.name ?? "")}
          recipient={recipient}
          sender={sender}
        />
      </aside>
    </div>
  );
}
