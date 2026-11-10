// A sequence drawn day by day: one dot per step on a line, spaced by the days between them, with
// the due date marked. Dots are coloured by tone (friendly → neutral → firm, red for the final
// notice) and hollow when the step waits for approval. Server-safe.
import { Fragment } from "react";
import { cx } from "@/components/ui";
import type { Tone } from "@/lib/types";
import { dayBadge, dotClass, TONE_LABEL } from "./state";

export interface TimelineStep {
  offsetDays: number;
  tone: Tone;
  requiresApproval: boolean;
  isFinalNotice: boolean;
}

function Connector({ days }: { days: number }) {
  // Square-root spacing: a 30-day gap looks longer than a 3-day gap without crowding the rest.
  return <span aria-hidden="true" className="mt-[7px] h-px min-w-2 bg-line-strong" style={{ flexGrow: Math.sqrt(Math.max(1, days)) }} />;
}

function describe(step: TimelineStep, kind: "standard" | "plan"): string {
  const anchor = kind === "plan" ? "the installment due date" : "the due date";
  const n = Math.abs(step.offsetDays);
  const when = step.offsetDays === 0 ? `On ${anchor}` : `${n} ${n === 1 ? "day" : "days"} ${step.offsetDays < 0 ? "before" : "after"} ${anchor}`;
  const parts = [when, `${TONE_LABEL[step.tone]} tone`];
  if (step.isFinalNotice) parts.push("final notice");
  if (step.requiresApproval) parts.push("waits for approval");
  return parts.join(", ");
}

export function SequenceTimeline({ steps, kind }: { steps: TimelineStep[]; kind: "standard" | "plan" }) {
  const sorted = [...steps].sort((a, b) => a.offsetDays - b.offsetDays);
  if (sorted.length === 0) return null;
  const hasDue = sorted.some((s) => s.offsetDays === 0);
  // A due-date tick between the last step before and the first step after, when no step is on it.
  const dueAt = hasDue ? -1 : sorted.findIndex((s) => s.offsetDays > 0);
  const showDueTick = !hasDue && dueAt > 0;

  return (
    <div className="overflow-x-auto">
      <ol aria-label="Steps, in send order" className="flex min-w-max items-start sm:min-w-0">
        {sorted.map((step, i) => {
          const prev = sorted[i - 1];
          return (
            <Fragment key={i}>
              {showDueTick && i === dueAt ? (
                <>
                  <Connector days={-prev.offsetDays} />
                  <li aria-hidden="true" className="flex w-9 shrink-0 flex-col items-center gap-1">
                    <span className="mt-[1px] h-3.5 w-px bg-ink-3" />
                    <span className="text-[11.5px] leading-4 font-medium text-ink-3">Due</span>
                  </li>
                  <Connector days={step.offsetDays} />
                </>
              ) : prev ? (
                <Connector days={step.offsetDays - prev.offsetDays} />
              ) : null}
              <li className="flex w-14 shrink-0 flex-col items-center gap-1">
                <span aria-hidden="true" className={cx("mb-0.5 size-3.5 rounded-full", dotClass(step.tone, step.isFinalNotice, step.requiresApproval))} />
                <span aria-hidden="true" className={cx("num text-[12px] leading-4 whitespace-nowrap", step.offsetDays === 0 ? "font-semibold text-ink" : "text-ink-2")}>
                  {dayBadge(step.offsetDays)}
                </span>
                <span aria-hidden="true" className="-mt-0.5 text-[11.5px] leading-4 whitespace-nowrap text-ink-3">
                  {step.isFinalNotice ? "Final" : TONE_LABEL[step.tone]}
                </span>
                <span className="sr-only">{describe(step, kind)}</span>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

// The key for the dots, shown once above the lists.
export function TimelineLegend() {
  const item = (cls: string, label: string) => (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className={cx("size-2.5 rounded-full", cls)} />
      {label}
    </li>
  );
  return (
    <ul aria-label="Key" className="flex flex-wrap gap-x-4 gap-y-1.5 text-small text-ink-2">
      {item(dotClass("friendly", false, false), "Friendly")}
      {item(dotClass("neutral", false, false), "Neutral")}
      {item(dotClass("firm", false, false), "Firm")}
      {item(dotClass("custom", false, false), "Custom")}
      {item("border-2 border-danger-fill bg-danger-fill", "Final notice")}
      {item("border-2 border-ink-3 bg-surface", "Waits for your approval")}
    </ul>
  );
}
