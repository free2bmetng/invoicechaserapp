"use client";

// The payment-plan editor, shown inside the "Payment plan" EditableSection. Rows of date and
// amount (the currency is shown on every amount), a running total, Save and Cancel.
// It closes itself after a successful save.
import { useActionState, useEffect, useState } from "react";
import { setPaymentPlanAction } from "@/app/actions/invoices";
import { useEditableSection } from "@/components/data";
import { Button, TextInput } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { IDLE_FORM_STATE } from "./form-state";
import { addDaysIso, minorToInput } from "./format";
import { AmountInput } from "./amount-input";
import { formatMoneyInput, parseTypedMoney } from "./money-input";

const MAX_ROWS = 60;

export interface InstallmentInputRow {
  dueDate: string;
  amountMinor: number;
  status: "open" | "paid";
}

interface Row {
  key: number;
  date: string;
  amount: string;
}

// Two installments that split the amount evenly, the second due 30 days after the first.
function defaultRows(totalMinor: number, currency: string, dueDate: string): Row[] {
  const first = Math.floor(totalMinor / 2);
  return [
    { key: 0, date: dueDate, amount: formatMoneyInput(minorToInput(first, currency), currency) },
    { key: 1, date: addDaysIso(dueDate, 30), amount: formatMoneyInput(minorToInput(totalMinor - first, currency), currency) },
  ];
}

export function PaymentPlanPanel({
  invoiceId,
  currency,
  totalMinor,
  dueDate,
  existing,
}: {
  invoiceId: string;
  currency: string;
  totalMinor: number;
  dueDate: string;
  existing: InstallmentInputRow[];
}) {
  const [state, formAction, pending] = useActionState(setPaymentPlanAction, IDLE_FORM_STATE);
  const section = useEditableSection();
  const [rows, setRows] = useState<Row[]>(() =>
    existing.length > 0
      ? existing.map((i, index) => ({ key: index, date: i.dueDate, amount: formatMoneyInput(minorToInput(i.amountMinor, currency), currency) }))
      : defaultRows(totalMinor, currency, dueDate),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  useEffect(() => {
    if (state.ok) section?.close();
  }, [state, section]);

  // The running total, so the user sees the gap before saving. The engine has the final say.
  let allocated = 0;
  let unreadable = false;
  for (const row of rows) {
    try {
      allocated += parseTypedMoney(row.amount, currency);
    } catch {
      unreadable = true;
    }
  }
  const difference = totalMinor - allocated;

  function update(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="installmentCount" value={rows.length} />

      <div className="grid gap-2" role="group" aria-label="Installments">
        <div aria-hidden="true" className="hidden grid-cols-[2rem_minmax(0,11rem)_minmax(0,12rem)_2.75rem] gap-3 text-small text-ink-3 sm:grid">
          <span>#</span>
          <span>Due date</span>
          <span>Amount</span>
          <span />
        </div>
        {rows.map((row, index) => {
          const dateError = state.fieldErrors[`installmentDate_${index}`];
          const amountError = state.fieldErrors[`installmentAmount_${index}`];
          return (
            <div key={row.key} className="grid grid-cols-[2rem_minmax(0,1fr)_2.75rem] items-start gap-x-3 gap-y-2 sm:grid-cols-[2rem_minmax(0,11rem)_minmax(0,12rem)_2.75rem]">
              <span className="num pt-3 text-body font-medium text-ink-3">{index + 1}</span>
              <div className="grid gap-1">
                <label htmlFor={`installmentDate_${index}`} className="sr-only">Installment {index + 1} due date</label>
                <TextInput id={`installmentDate_${index}`} name={`installmentDate_${index}`} type="date" value={row.date} width="full"
                  onChange={(e) => update(row.key, { date: e.currentTarget.value })} aria-invalid={dateError ? true : undefined} />
                {dateError ? <p role="alert" className="text-[12.5px] text-danger">{dateError}</p> : null}
              </div>
              <div className="col-start-2 row-start-2 grid gap-1 sm:col-start-3 sm:row-start-1">
                <label htmlFor={`installmentAmount_${index}`} className="sr-only">Installment {index + 1} amount in {currency}</label>
                <div className="relative">
                  <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-small font-medium text-ink-3">{currency}</span>
                  <AmountInput id={`installmentAmount_${index}`} name={`installmentAmount_${index}`} value={row.amount} currency={currency}
                    onValueChange={(value) => update(row.key, { amount: value })} aria-invalid={amountError ? true : undefined} className="pl-12 text-right" />
                </div>
                {amountError ? <p role="alert" className="text-[12.5px] text-danger">{amountError}</p> : null}
              </div>
              <button
                type="button"
                disabled={rows.length <= 2}
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                aria-label={`Remove installment ${index + 1}`}
                title={rows.length <= 2 ? "A plan needs at least two installments" : `Remove installment ${index + 1}`}
                className="col-start-3 row-start-1 grid size-11 place-items-center rounded-[10px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3 sm:col-start-4"
              >
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <Button type="button" variant="ghost" size="sm" disabled={rows.length >= MAX_ROWS}
          onClick={() => {
            setRows((prev) => {
              const last = prev[prev.length - 1];
              return [...prev, { key: nextKey, date: last ? addDaysIso(last.date, 30) : dueDate, amount: "" }];
            });
            setNextKey((k) => k + 1);
          }}>
          + Add installment
        </Button>
        <p role="status" className={`num text-small ${!unreadable && difference === 0 ? "font-medium text-ok" : difference < 0 ? "text-danger" : "text-ink-2"}`}>
          {unreadable
            ? "Check the amounts."
            : difference === 0
              ? `Adds up to ${formatMoney(totalMinor, currency)}`
              : difference > 0
                ? `${formatMoney(difference, currency)} left to allocate`
                : `${formatMoney(-difference, currency)} more than the invoice`}
        </p>
      </div>

      {state.ok === false && state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save payment plan"}</Button>
        <Button type="button" variant="ghost" data-edit-cancel>Cancel</Button>
      </div>
    </form>
  );
}
