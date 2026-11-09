"use client";

import { useActionState } from "react";
import { setInvoiceStatusAction } from "@/app/actions/invoices";
import { Button, cx } from "@/components/ui";
import type { InvoiceStatus } from "@/lib/types";
import { IDLE_FORM_STATE } from "./form-state";
import { STATUS_CONTROLS } from "./format";

// The status panel. The stop rule is said once, here; each option has one line of its own.
export function StatusPanel({ invoiceId, status }: { invoiceId: string; status: InvoiceStatus }) {
  const [state, formAction, pending] = useActionState(setInvoiceStatusAction, IDLE_FORM_STATE);

  return (
    <div className="grid gap-4">
      <p className="text-[13.5px] leading-6 text-ink-2">
        Pausing, disputing, marking paid or writing off stops everything. Unsent reminders are cancelled right away.
      </p>

      {status === "payment_plan" ? (
        <p className="text-[13.5px] leading-6 text-ink-2">Reminders follow the installment dates in the payment plan below.</p>
      ) : null}

      <ul className="grid gap-2" aria-label="Status controls">
        {STATUS_CONTROLS.filter((c) => !(status === "payment_plan" && c.status === "open")).map((control) => {
          const current = control.status === status;
          return (
            <li
              key={control.status}
              className={cx(
                "flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border px-4 py-3",
                current ? "border-accent/40 bg-accent-soft/50" : "border-line bg-surface",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                  {control.button}
                  {current ? <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-accent">Current</span> : null}
                </p>
                <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{control.short}</p>
              </div>
              {current ? null : (
                <form action={formAction}>
                  <input type="hidden" name="invoiceId" value={invoiceId} />
                  <input type="hidden" name="status" value={control.status} />
                  <Button type="submit" size="sm" variant={control.status === "paid" ? "primary" : "secondary"} disabled={pending}>
                    {control.button}
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      <p role="status" aria-live="polite" className={cx("text-[13px]", state.ok === false ? "text-danger" : "text-ink-2")}>
        {state.message ?? ""}
      </p>
    </div>
  );
}
