"use client";

// Building blocks for the settings and onboarding forms: one hook that submits a server action,
// field wrappers that wire labels, hints and errors together, the action row with its status line,
// and a panel frame that matches EditableSection for sections that are not edit forms.
import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Button, cx } from "@/components/ui";
import { IDLE_FORM_STATE, type FormState } from "./state";

export type FormAction = (previous: FormState, formData: FormData) => Promise<FormState>;

// Submits through the action inside a transition, and does not hand the form to React's
// <form action>. React resets uncontrolled fields after a form action, which would clear a
// <select> the user just changed when validation fails. Keeping submission in our own handler
// keeps every value on screen after a save, a refusal or a validation error.
export function useSettingsForm(action: FormAction) {
  const [state, dispatch, pending] = useActionState(action, IDLE_FORM_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  // After a refused save, focus the first field with an error so keyboard and screen reader users land on it.
  useEffect(() => {
    if (state.status === "error" && Object.keys(state.fieldErrors).length > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, formRef, onSubmit };
}

// Attributes that tie an input to its hint or its error. The error replaces the hint, so the
// input is described by whichever one is on screen.
export function fieldProps(id: string, options: { hasHint?: boolean; error?: string } = {}) {
  const describedBy = options.error ? `${id}-error` : options.hasHint ? `${id}-hint` : undefined;
  return {
    id,
    "aria-invalid": options.error ? ("true" as const) : undefined,
    "aria-describedby": describedBy,
  };
}

// Every field here is required unless its label says otherwise, so no per-field marker is shown.
// Inputs still carry aria-required, so assistive technology hears the requirement.
// One line under the field: the error when there is one, otherwise the hint.
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-small font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-small text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// The same frame and header as EditableSection, for sections that hold a list or a link rather
// than an edit form (passkeys, Stripe, the data download). `action` sits top right, like Edit.
export function Panel({
  title,
  description,
  action,
  tone = "neutral",
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger";
  children?: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx(
        "rounded-[var(--radius-lg)] border bg-surface shadow-card",
        tone === "danger" ? "border-danger/45" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="min-w-0">
          <h2 id={headingId} className={cx("text-card-title", tone === "danger" ? "text-danger" : "text-ink")}>
            {title}
          </h2>
          {description ? <div className="mt-0.5 text-small text-ink-3">{description}</div> : null}
        </div>
        {action ? <div className="-my-1.5 shrink-0">{action}</div> : null}
      </div>
      <div className={cx("px-4 pb-4 sm:px-6 sm:pb-5", children ? "pt-3" : "pt-0")}>{children}</div>
    </section>
  );
}

export function StatusLine({ state, className }: { state: FormState; className?: string }) {
  const tone =
    state.status === "error" ? "text-danger" : state.status === "warning" ? "text-warn" : state.status === "saved" ? "text-ok" : "text-ink-2";
  return (
    <p role="status" aria-live="polite" className={cx("min-w-0 text-small font-medium empty:hidden", tone, className)}>
      {state.message}
    </p>
  );
}

// Save (primary) and an optional Cancel that closes the EditableSection, with the status beside them.
export function FormActions({
  pending,
  state,
  idleLabel,
  pendingLabel,
  cancel = true,
  disabled = false,
  danger = false,
}: {
  pending: boolean;
  state: FormState;
  idleLabel: string;
  pendingLabel: string;
  cancel?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant={danger ? "danger" : "primary"}
          disabled={pending || disabled}
          aria-busy={pending || undefined}
          className="max-sm:flex-1"
        >
          {pending ? pendingLabel : idleLabel}
        </Button>
        {cancel ? (
          <Button type="button" variant="ghost" data-edit-cancel="" disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
      <StatusLine state={state} />
    </div>
  );
}

export type CalloutTone = "warn" | "info" | "danger" | "neutral";

const calloutTone: Record<CalloutTone, string> = {
  warn: "border-warn/30 bg-warn-soft",
  info: "border-info/25 bg-info-soft",
  danger: "border-danger/30 bg-danger-soft",
  neutral: "border-line bg-surface-2",
};

export function Callout({ tone = "neutral", children, className }: { tone?: CalloutTone; children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[var(--radius-md)] border px-4 py-3 text-body text-ink", calloutTone[tone], className)}>
      {children}
    </div>
  );
}
