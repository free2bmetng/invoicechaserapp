"use client";

// The header actions on an invoice: ONE main action that depends on the status, and a quieter
// "Change status" control with everything else. No modal: the menu opens in place, and a change
// that needs care (a dispute reason, a write-off) asks for a second click inside it.
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { recordInstallmentAction, setInvoiceStatusAction } from "@/app/actions/invoices";
import { Button, Textarea, cx } from "@/components/ui";
import type { InvoiceStatus } from "@/lib/types";
import { IDLE_FORM_STATE, type FormState } from "./form-state";
import { mainActionFor, statusChangesFor, type StatusChange } from "./status-model";

export function InvoiceActions({
  invoiceId,
  status,
  nextInstallment,
}: {
  invoiceId: string;
  status: InvoiceStatus;
  // The next unpaid installment of a payment plan, for "Record installment".
  nextInstallment: { id: string; label: string } | null;
}) {
  const [statusState, statusAction, statusPending] = useActionState(setInvoiceStatusAction, IDLE_FORM_STATE);
  const [planState, planAction, planPending] = useActionState(recordInstallmentAction, IDLE_FORM_STATE);
  const [last, setLast] = useState<"status" | "plan" | null>(null);
  const main = mainActionFor(status, { hasOpenInstallment: nextInstallment !== null });
  const changes = statusChangesFor(status);
  const pending = statusPending || planPending;
  const feedback: FormState = last === "plan" ? planState : statusState;

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        {changes.length > 0 ? (
          <StatusMenu
            invoiceId={invoiceId}
            changes={changes}
            action={statusAction}
            pending={pending}
            done={statusState}
            onSubmit={() => setLast("status")}
          />
        ) : null}
        {main.kind === "record_installment" && nextInstallment ? (
          <form action={planAction} onSubmit={() => setLast("plan")}>
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <input type="hidden" name="installmentId" value={nextInstallment.id} />
            <Button type="submit" variant={main.variant} disabled={pending} className="w-full sm:w-auto" aria-describedby="main-action-hint">
              {planPending ? "Recording…" : `Record ${nextInstallment.label}`}
            </Button>
          </form>
        ) : (
          <form action={statusAction} onSubmit={() => setLast("status")}>
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <input type="hidden" name="status" value={main.status} />
            <Button type="submit" variant={main.variant} disabled={pending} className="w-full sm:w-auto" aria-describedby="main-action-hint">
              {statusPending && last === "status" ? "Saving…" : main.label}
            </Button>
          </form>
        )}
      </div>
      <p id="main-action-hint" className="sr-only">{main.hint}</p>
      <p role="status" aria-live="polite" className={cx("text-small sm:text-right", feedback.ok === false ? "text-danger" : "text-ink-2", !feedback.message && "sr-only")}>
        {feedback.message ?? ""}
      </p>
    </div>
  );
}

function StatusMenu({
  invoiceId,
  changes,
  action,
  pending,
  done,
  onSubmit,
}: {
  invoiceId: string;
  changes: StatusChange[];
  action: (formData: FormData) => void;
  pending: boolean;
  done: FormState;
  onSubmit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<StatusChange | null>(null);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Close after a change succeeds (the page re-renders with the new status).
  const [seen, setSeen] = useState(done);
  if (done !== seen) {
    setSeen(done);
    if (done.ok) {
      setOpen(false);
      setConfirming(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(null);
        button.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button
        ref={button}
        type="button"
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(null);
        }}
        className="w-full sm:w-auto"
      >
        Change status
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className={cx("text-ink-3 transition-transform", open && "rotate-180")}>
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {open ? (
        <div
          id={panelId}
          className="z-20 mt-2 w-full overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[0_12px_32px_-8px_rgb(0_0_0/0.18)] sm:absolute sm:right-0 sm:w-80 dark:bg-surface-2"
        >
          {confirming ? (
            <form action={action} onSubmit={onSubmit} className="grid gap-3 p-4">
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <input type="hidden" name="status" value={confirming.status} />
              <p className="text-body font-medium text-ink">{confirming.label}?</p>
              {confirming.confirm === "reason" ? (
                <div className="grid gap-1.5">
                  <label htmlFor={`${panelId}-note`} className="text-small font-medium text-ink">What does the client dispute?</label>
                  <Textarea id={`${panelId}-note`} name="note" maxLength={2000} placeholder="Optional. Saved as a note on the invoice." className="min-h-[76px]" autoFocus />
                  <p className="text-small text-ink-3">{confirming.description}</p>
                </div>
              ) : (
                <p className="text-small text-ink-2">{confirming.description} Unsent reminders are cancelled.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" variant={confirming.confirm === "danger" ? "danger" : "primary"} disabled={pending}>
                  {pending ? "Saving…" : confirming.label}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>Back</Button>
              </div>
            </form>
          ) : (
            <ul className="divide-y divide-line" aria-label="Status changes">
              {changes.map((change) => (
                <li key={change.status}>
                  {change.confirm === "none" ? (
                    <form action={action} onSubmit={onSubmit}>
                      <input type="hidden" name="invoiceId" value={invoiceId} />
                      <input type="hidden" name="status" value={change.status} />
                      <MenuItem change={change} disabled={pending} type="submit" />
                    </form>
                  ) : (
                    <MenuItem change={change} disabled={pending} type="button" onClick={() => setConfirming(change)} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ change, disabled, type, onClick }: { change: StatusChange; disabled: boolean; type: "submit" | "button"; onClick?: () => void }) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="grid min-h-14 w-full gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-60 dark:hover:bg-surface-3"
    >
      <span className={cx("text-body font-medium", change.confirm === "danger" ? "text-danger" : "text-ink")}>{change.label}</span>
      <span className="text-small text-ink-3">{change.description}</span>
    </button>
  );
}
