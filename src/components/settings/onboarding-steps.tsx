// Onboarding navigation and the step-4 sequence summary. Server-rendered: plain links and text.
import Link from "next/link";
import { cx } from "@/components/ui";
import type { OnboardingStep, OnboardingStepKey, SequenceStepSummary } from "@/lib/queries/settings";

// A link styled like a secondary or primary button, for steps that send the user elsewhere.
export function LinkButton({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={cx(
        "lift inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-medium whitespace-nowrap select-none",
        primary
          ? "bg-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.18)_inset,0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover"
          : "border border-line-strong bg-surface text-ink shadow-card hover:border-ink-3 hover:bg-surface-2",
      )}
    >
      {children}
    </Link>
  );
}

export const ONBOARDING_STEP_PATHS: Record<OnboardingStepKey, string> = {
  profile: "/onboarding/profile",
  sending: "/onboarding/sending",
  invoices: "/onboarding/invoices",
  review: "/onboarding/review",
};

const STEP_NUMBER: Record<OnboardingStepKey, number> = { profile: 1, sending: 2, invoices: 3, review: 4 };

function statusText(step: OnboardingStep): string {
  if (step.done) return "Done";
  return step.required ? "To do" : "Optional";
}

// On a phone, one compact line says where the user is. The four cards show from the sm breakpoint up.
// Only one of the two is in the layout at a time, so screen readers hear each step once.
export function OnboardingProgress({ steps, current }: { steps: OnboardingStep[]; current?: OnboardingStepKey }) {
  const currentIndex = current ? steps.findIndex((step) => step.key === current) : -1;
  const requiredTotal = steps.filter((step) => step.required).length;
  const requiredDone = steps.filter((step) => step.required && step.done).length;
  const line =
    currentIndex >= 0
      ? `Step ${currentIndex + 1} of ${steps.length}: ${steps[currentIndex].title}`
      : `${requiredDone} of ${requiredTotal} required steps done`;
  return (
    <>
      <p className="text-[14px] leading-6 text-ink-2 sm:hidden">
        <span className="font-medium text-ink">{line}</span>
      </p>
      <OnboardingSteps steps={steps} current={current} />
    </>
  );
}

export function OnboardingSteps({ steps, current }: { steps: OnboardingStep[]; current?: OnboardingStepKey }) {
  return (
    <ol aria-label="Setup steps" className="grid gap-3 sm:grid-cols-2">
      {steps.map((step) => {
        const isCurrent = step.key === current;
        return (
          <li key={step.key}>
            <Link
              href={ONBOARDING_STEP_PATHS[step.key]}
              aria-current={isCurrent ? "step" : undefined}
              className={cx(
                "flex h-full items-start gap-3 rounded-[var(--radius-md)] border p-4 transition-colors duration-150",
                isCurrent ? "border-accent/40 bg-accent-soft" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2",
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
                  step.done ? "bg-ok-soft text-ok" : "bg-surface-2 text-ink-2",
                )}
              >
                {step.done ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  STEP_NUMBER[step.key]
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-ink">
                  <span className="sr-only">Step {STEP_NUMBER[step.key]}: </span>
                  {step.title}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-ink-3">{statusText(step)}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function SequenceSummary({ steps }: { steps: SequenceStepSummary[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-[14px] leading-6 text-ink-2">
        No default reminders are set up yet. They are created when you next sign in. You can also build your own on the
        Sequences page.
      </p>
    );
  }
  return (
    <ol className="flex flex-col divide-y divide-line rounded-[var(--radius-md)] border border-line">
      {steps.map((step, index) => (
        <li key={index} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">{offsetText(step.offsetDays)}</p>
            <p className="mt-0.5 truncate text-[13px] text-ink-2" title={step.subject}>
              {step.subject}
            </p>
          </div>
          <p className="shrink-0 text-[12.5px] text-ink-3">
            {toneText(step.tone)}
            {step.requiresApproval ? " · You approve it first" : " · Sends on schedule"}
          </p>
        </li>
      ))}
    </ol>
  );
}

// Spelled out, so the timing reads the same way the sequence editor describes it.
export function offsetText(days: number): string {
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} before the due date`;
  if (days === 0) return "On the due date";
  return `${days} ${days === 1 ? "day" : "days"} after the due date`;
}

function toneText(tone: string): string {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}
