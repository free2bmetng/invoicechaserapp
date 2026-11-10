// Onboarding: the step copy, the checklist on the hub, the compact header on each step page, and the
// step-4 reminder summary. Server-rendered: plain links and text. Finish is the one client part.
import Link from "next/link";
import type { ReactNode } from "react";
import { ProgressRing, Table, TBody, Td, Th, THead, Tr } from "@/components/data";
import { Badge, buttonClass, Card, cx } from "@/components/ui";
import type { OnboardingNext, OnboardingStep, OnboardingStepKey, SequenceStepSummary } from "@/lib/queries/settings";
import { FinishOnboardingForm } from "./finish-onboarding-form";

export const ONBOARDING_STEP_PATHS: Record<OnboardingStepKey, string> = {
  profile: "/onboarding/profile",
  sending: "/onboarding/sending",
  invoices: "/onboarding/invoices",
  review: "/onboarding/review",
};

const STEP_ORDER: OnboardingStepKey[] = ["profile", "sending", "invoices", "review"];

// What each step is called on screen, and the one line shown when it is the next step.
export const STEP_COPY: Record<OnboardingStepKey, { title: string; detail: string }> = {
  profile: {
    title: "Add your sender details",
    detail: "Your name, business and postal address. Every reminder ends with them.",
  },
  sending: {
    title: "Set up your sending domain",
    detail: "The domain reminders come from, and the DNS records to add for it.",
  },
  invoices: {
    title: "Add your invoices",
    detail: "One at a time, or import a CSV file. You can do this later.",
  },
  review: {
    title: "Review the default reminders",
    detail: "Check when they go out and what they say before anything is planned.",
  },
};

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-ink-3">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StepMark({ number, done, next }: { number: number; done: boolean; next: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-7 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold",
        done
          ? "bg-ok-fill text-surface"
          : next
            ? "bg-accent text-accent-ink"
            : "border border-control-border text-ink-2",
      )}
    >
      {done ? <CheckIcon /> : number}
    </span>
  );
}

// The hub: a Stripe-style checklist. The next step is highlighted with its one primary action;
// every other step is a compact link row, so a phone can still reach each one.
export function OnboardingChecklist({ steps, next }: { steps: OnboardingStep[]; next: OnboardingNext }) {
  const doneCount = steps.filter((step) => step.done).length;
  const finished = next.kind === "done";

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-4 border-b border-line px-4 py-4 sm:px-6">
        <ProgressRing value={doneCount} max={steps.length} label="Setup progress" />
        <div className="min-w-0">
          <h2 className="text-card-title text-ink">{finished ? "Setup is complete" : "Setup checklist"}</h2>
          <p className="text-small text-ink-3">
            {doneCount} of {steps.length} steps done
          </p>
        </div>
      </div>

      <ol aria-label="Setup steps">
        {steps.map((step) => {
          const number = STEP_ORDER.indexOf(step.key) + 1;
          const isNext = next.kind === "step" && next.key === step.key;
          const copy = STEP_COPY[step.key];
          const href = ONBOARDING_STEP_PATHS[step.key];
          const status = step.done ? "Done" : step.required ? null : "Optional";

          if (isNext) {
            return (
              <li
                key={step.key}
                aria-current="step"
                className="border-b border-line bg-accent-soft/60 px-4 py-4 shadow-[inset_3px_0_0_var(--color-accent)] sm:px-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <StepMark number={number} done={false} next />
                    <div className="min-w-0">
                      <p className="text-body font-semibold text-ink">
                        <span className="sr-only">Next, step {number}: </span>
                        {copy.title}
                      </p>
                      <p className="mt-0.5 text-small text-ink-2">{copy.detail}</p>
                    </div>
                  </div>
                  <Link href={href} className={cx(buttonClass("primary"), "max-sm:w-full")}>
                    Continue
                  </Link>
                </div>
              </li>
            );
          }

          return (
            <li key={step.key} className="border-b border-line">
              <Link
                href={href}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2/70 sm:px-6"
              >
                <StepMark number={number} done={step.done} next={false} />
                <span className={cx("min-w-0 flex-1 text-body", step.done ? "text-ink-2" : "text-ink")}>
                  <span className="sr-only">Step {number}: </span>
                  {copy.title}
                </span>
                {status ? <span className={cx("text-small", step.done ? "text-ok" : "text-ink-3")}>{status}</span> : null}
                <Chevron />
              </Link>
            </li>
          );
        })}
        <FinishRow next={next} />
      </ol>
    </Card>
  );
}

function FinishRow({ next }: { next: OnboardingNext }) {
  if (next.kind === "done") {
    return (
      <li className="flex flex-col gap-3 bg-ok-soft/50 px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <StepMark number={5} done next={false} />
          <div className="min-w-0">
            <p className="text-body font-semibold text-ink">Reminders are planned</p>
            <p className="mt-0.5 text-small text-ink-2">Every open invoice now follows its reminder sequence.</p>
          </div>
        </div>
        <Link href="/" className={cx(buttonClass("primary"), "max-sm:w-full")}>
          Go to the dashboard
        </Link>
      </li>
    );
  }
  if (next.kind === "finish") {
    return (
      <li aria-current="step" className="bg-accent-soft/60 px-4 py-4 shadow-[inset_3px_0_0_var(--color-accent)] sm:px-6">
        <FinishOnboardingForm />
      </li>
    );
  }
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5 sm:px-6">
      <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-control-border text-ink-3">
        <FlagIcon />
      </span>
      <span className="min-w-0 flex-1 text-body text-ink-3">Finish setup</span>
      <span className="text-small text-ink-3">After steps 1, 2 and 4</span>
    </li>
  );
}

function FlagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 21V4m0 0h10l-2 4 2 4H6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The compact header on each step page: where you are, once, and the way back to the checklist.
export function OnboardingStepHeader({
  step,
  steps,
  title,
  description,
}: {
  step: OnboardingStepKey;
  steps: OnboardingStep[];
  title: string;
  description: ReactNode;
}) {
  const number = STEP_ORDER.indexOf(step) + 1;
  return (
    <header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href="/onboarding"
          className="-ml-2 inline-flex h-11 items-center gap-1 rounded-[8px] px-2 text-small font-medium text-ink-2 hover:bg-surface-2 hover:text-ink sm:h-8"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Setup
        </Link>
        <span className="text-small text-ink-3">
          Step {number} of {STEP_ORDER.length}
        </span>
        <span aria-hidden="true" className="flex gap-1">
          {STEP_ORDER.map((key) => {
            const done = steps.find((s) => s.key === key)?.done;
            return (
              <span
                key={key}
                className={cx("h-1.5 w-6 rounded-full", key === step ? "bg-accent" : done ? "bg-ok-fill" : "bg-surface-3")}
              />
            );
          })}
        </span>
      </div>
      <h1 className="mt-2 text-page-title text-ink">{title}</h1>
      <p className="mt-1 max-w-2xl text-body text-ink-2">{description}</p>
    </header>
  );
}

// Step 4: the default reminders as a table of timing, subject, tone and approval.
export function SequenceSummary({ steps }: { steps: SequenceStepSummary[] }) {
  if (steps.length === 0) {
    return (
      <p className="px-4 py-4 text-body text-ink-2 sm:px-6">
        No default reminders yet. They are created the next time you sign in, or you can build your own on the Sequences
        page.
      </p>
    );
  }
  return (
    <Table label="Default reminders">
      <THead>
        <Th>When</Th>
        <Th>Subject</Th>
        <Th>Tone</Th>
        <Th>Sending</Th>
      </THead>
      <TBody>
        {steps.map((step, index) => (
          <Tr key={index}>
            <Td primary>{offsetText(step.offsetDays)}</Td>
            <Td label="Subject">
              <SubjectText subject={step.subject} />
            </Td>
            <Td label="Tone">{toneText(step.tone)}</Td>
            <Td label="Sending">
              {step.requiresApproval ? <Badge tone="warn">You approve first</Badge> : <Badge>Automatic</Badge>}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

// Merge fields such as {invoice_number} shown as quiet chips, so the subject reads as a sentence.
function SubjectText({ subject }: { subject: string }) {
  const parts = subject.split(/(\{[a-z_]+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const field = /^\{([a-z_]+)\}$/.exec(part);
        if (!field) return part;
        return (
          <span key={index} className="mx-0.5 rounded-[6px] border border-line bg-surface-2 px-1.5 py-px text-small whitespace-nowrap text-ink-2">
            {field[1].replace(/_/g, " ")}
          </span>
        );
      })}
    </>
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

