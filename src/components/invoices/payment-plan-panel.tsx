"use client";

import { useActionState, useState } from "react";
import { setPaymentPlanAction } from "@/app/actions/invoices";
import { Button, Field, TextInput } from "@/components/ui";
import { parseMoneyToMinor, formatMoney } from "@/lib/money";
import { IDLE_FORM_STATE } from "./form-state";
import { addDaysIso, dueDateLabel, minorToInput } from "./format";

const MAX_ROWS = 60;

export interface InstallmentInputRow {
  dueDate: string;
  amountMinor: number;
  status: "open" | "paid";
}

interface Row {
  date: string;
  amount: string;
}

// Two installments that split the amount evenly, the second due 30 days after the first.
function defaultRows(totalMinor: number, currency: string, dueDate: string): Row[] {
  const first = Math.floor(totalMinor / 2);
  return [
    { date: dueDate, amount: minorToInput(first, currency) },
    { date: addDaysIso(dueDate, 30), amount: minorToInput(totalMinor - first, currency) },
  ];
}

export function PaymentPlanPanel({
  invoiceId,
  currency,
  totalMinor,
  dueDate,
  existing,
  lockedReason,
}: {
  invoiceId: string;
  currency: string;
  totalMinor: number;
  dueDate: string;
  existing: InstallmentInputRow[];
  lockedReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(setPaymentPlanAction, IDLE_FORM_STATE);
  const [rows, setRows] = useState<Row[]>(() =>
    existing.length > 0
      ? existing.map((i) => ({ date: i.dueDate, amount: minorToInput(i.amountMinor, currency) }))
      : defaultRows(totalMinor, currency, dueDate),
  );

  if (lockedReason) {
    return (
      <div className="grid gap-4">
        <p className="text-[14px] leading-6 text-ink-2">{lockedReason}</p>
        {existing.length > 0 ? (
          <ol className="grid gap-2">
            {existing.map((i, index) => (
              <li key={`${i.dueDate}-${index}`} className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5 text-[14px]">
                <span className="text-ink-2">Installment {index + 1} · {dueDateLabel(i.dueDate)}</span>
                <span className="num font-medium text-ink">
                  {formatMoney(i.amountMinor, currency)} {i.status === "paid" ? <span className="ml-2 text-[12px] font-semibold text-ok">Paid</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }

  // The running total, so the user sees the gap before submitting. The engine has the final say.
  let allocated = 0;
  let unreadable = false;
  for (const row of rows) {
    try {
      allocated += parseMoneyToMinor(row.amount, currency);
    } catch {
      unreadable = true;
    }
  }
  const difference = totalMinor - allocated;
  const totalText = formatMoney(totalMinor, currency);
  const allocatedText = formatMoney(allocated, currency);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="installmentCount" value={rows.length} />

      <ol className="grid gap-3" aria-label="Installments">
        {rows.map((row, index) => {
          const dateError = state.fieldErrors[`installmentDate_${index}`];
          const amountError = state.fieldErrors[`installmentAmount_${index}`];
          return (
            <li key={index} className="grid gap-3 rounded-[var(--radius-md)] border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <Field id={`installmentDate_${index}`} label={`Installment ${index + 1} date`} error={dateError}>
                <TextInput id={`installmentDate_${index}`} name={`installmentDate_${index}`} type="date" value={row.date}
                  onChange={(e) => update(index, { date: e.currentTarget.value })} aria-invalid={dateError ? true : undefined} />
              </Field>
              <Field id={`installmentAmount_${index}`} label={`Installment ${index + 1} amount`} error={amountError}>
                <TextInput id={`installmentAmount_${index}`} name={`installmentAmount_${index}`} inputMode="decimal" value={row.amount}
                  onChange={(e) => update(index, { amount: e.currentTarget.value })} aria-invalid={amountError ? true : undefined} className="num" />
              </Field>
              <Button type="button" variant="ghost" size="sm" disabled={rows.length <= 2}
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                aria-label={`Remove installment ${index + 1}`}>
                Remove
              </Button>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="secondary" size="sm" disabled={rows.length >= MAX_ROWS}
          onClick={() =>
            setRows((prev) => {
              const last = prev[prev.length - 1];
              return [...prev, { date: last ? addDaysIso(last.date, 30) : dueDate, amount: "" }];
            })
          }>
          Add installment
        </Button>
        <p role="status" className={`num text-[13px] ${!unreadable && difference === 0 ? "text-ok" : "text-ink-2"}`}>
          {unreadable
            ? "Check the amounts."
            : difference === 0
              ? `Installments add up to ${totalText}.`
              : `${allocatedText} of ${totalText} allocated${difference > 0 ? `, ${formatMoney(difference, currency)} to go` : `, ${formatMoney(-difference, currency)} too many`}.`}
        </p>
      </div>

      {state.ok === false && state.message ? (
        <p role="alert" className="text-[13px] text-danger">{state.message}</p>
      ) : null}
      {state.ok === true && state.message ? <p role="status" className="text-[13px] text-ink-2">{state.message}</p> : null}

      <div>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save payment plan"}</Button>
      </div>
    </form>
  );
}
