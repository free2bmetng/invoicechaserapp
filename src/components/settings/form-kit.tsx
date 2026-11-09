"use client";

// Building blocks for the settings and onboarding forms: one hook that submits a server action,
// field wrappers that wire labels, hints and errors together, and the save bar with its status line.
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

// Attributes that tie an input to its hint and its error message. Pass hasHint when the Field has a hint.
export function fieldProps(id: string, options: { hasHint?: boolean; error?: string } = {}) {
  const describedBy = [options.hasHint ? `${id}-hint` : null, options.error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    "aria-invalid": options.error ? ("true" as const) : undefined,
    "aria-describedby": describedBy || undefined,
  };
}

// Every field here is required unless its label says otherwise, so no per-field marker is shown.
// Inputs still carry aria-required, so assistive technology hears the requirement.
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
      <label htmlFor={id} className="text-[13.5px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-[13px] leading-5 text-ink-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] leading-5 font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// level is the heading the card's title uses. Cards in a settings section use 3 (under the section's 2).
export function SettingsCard({
  id,
  title,
  description,
  children,
  className,
  level = 2,
}: {
  id: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
  className?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section
      aria-labelledby={id}
      className={cx("scroll-mt-28 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:p-7 lg:scroll-mt-8", className)}
    >
      <Heading id={id} className="text-[17px] leading-7 font-semibold tracking-[-0.01em] text-ink">
        {title}
      </Heading>
      <div className="mt-1.5 text-[14px] leading-6 text-ink-2">{description}</div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function StatusLine({ state }: { state: FormState }) {
  const tone =
    state.status === "error" ? "text-danger" : state.status === "warning" ? "text-warn" : state.status === "saved" ? "text-ok" : "text-ink-2";
  return (
    <p role="status" aria-live="polite" className={cx("min-w-0 text-[13.5px] leading-6 font-medium", tone)}>
      {state.message}
    </p>
  );
}

// A disabled button that stays readable. The base button fades to 50% opacity, which left the disabled
// "Finish setup" and "Connect Stripe" labels too pale to read. This keeps full contrast with a quiet surface.
export const readableDisabled =
  "disabled:opacity-100! disabled:border disabled:border-line disabled:bg-surface-2 disabled:text-ink-2 disabled:shadow-none";

export function SaveBar({
  pending,
  state,
  idleLabel,
  pendingLabel,
  disabled = false,
  danger = false,
  showStatus = true,
  children,
}: {
  pending: boolean;
  state: FormState;
  idleLabel: string;
  pendingLabel: string;
  disabled?: boolean;
  danger?: boolean;
  showStatus?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {showStatus ? <StatusLine state={state} /> : null}
        {children}
      </div>
      <Button
        type="submit"
        variant={danger ? "danger" : "primary"}
        disabled={pending || disabled}
        className={`w-full sm:w-auto ${readableDisabled}`}
        aria-busy={pending || undefined}
      >
        {pending ? pendingLabel : idleLabel}
      </Button>
    </div>
  );
}

export type CalloutTone = "warn" | "info" | "danger";

const calloutTone: Record<CalloutTone, string> = {
  warn: "border-warn/30 bg-warn-soft",
  info: "border-info/25 bg-info-soft",
  danger: "border-danger/30 bg-danger-soft",
};

export function Callout({ tone = "info", children }: { tone?: CalloutTone; children: ReactNode }) {
  return (
    <div className={cx("rounded-[var(--radius-md)] border px-4 py-3.5 text-[14px] leading-6 text-ink", calloutTone[tone])}>
      {children}
    </div>
  );
}
