// The sequences list. Server-rendered: each sequence is a row with its day-by-day timeline, how
// many open invoices use it (a link to them), and its actions.
import Link from "next/link";
import { Badge, Card, buttonClass } from "@/components/ui";
import type { SequenceView } from "@/lib/engine";
import type { Tone } from "@/lib/types";
import { describeCadence } from "./state";
import { DuplicateButton, MakeDefaultButton } from "./sequence-actions";
import { SequenceTimeline } from "./sequence-timeline";

export function usageText(count: number, kind: "standard" | "plan", isDefault: boolean): string {
  if (kind === "plan") {
    if (!isDefault) return "Not in use. Payment plans use the default plan sequence";
    return count === 0 ? "No payment plans yet" : `Used by ${count} ${count === 1 ? "payment plan" : "payment plans"}`;
  }
  return count === 0 ? "Not used by any open invoice" : `Used by ${count} open ${count === 1 ? "invoice" : "invoices"}`;
}

export function SequenceCards({ sequences, usage }: { sequences: SequenceView[]; usage: Map<string, number> }) {
  return (
    <Card className="overflow-hidden">
      <ul aria-label="Sequences">
        {sequences.map((s) => {
          const count = usage.get(s.id) ?? 0;
          const approvals = s.steps.filter((x) => x.requiresApproval).length;
          return (
            <li key={s.id} className="grid gap-4 border-b border-line px-4 py-4 last:border-b-0 sm:px-6 sm:py-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-8 lg:gap-y-3">
              <div className="grid min-w-0 content-start gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/sequences/${s.id}`} className="text-card-title text-ink underline-offset-4 hover:underline">
                    {s.name}
                  </Link>
                  {s.isDefault ? <Badge tone="accent">Default</Badge> : null}
                </div>
                <p className="text-small text-ink-2">
                  <span className="num">{s.steps.length}</span> {s.steps.length === 1 ? "step" : "steps"}
                  {approvals > 0 ? <> · <span className="num">{approvals}</span> {approvals === 1 ? "waits" : "wait"} for approval</> : null}
                </p>
                <p className="text-small">
                  {count > 0 ? (
                    <Link href={`/sequences/${s.id}#used-by`} className="font-medium text-accent underline-offset-4 hover:underline">
                      {usageText(count, s.kind, s.isDefault)}
                    </Link>
                  ) : (
                    <span className="text-ink-3">{usageText(count, s.kind, s.isDefault)}</span>
                  )}
                </p>
              </div>
              <div className="grid min-w-0 content-start gap-3 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-1">
                {s.steps.length === 0 ? (
                  <p className="text-body text-ink-2">No steps, so nothing is sent with this sequence.</p>
                ) : (
                  <>
                    <SequenceTimeline
                      kind={s.kind}
                      steps={s.steps.map((x) => ({
                        offsetDays: x.offsetDays,
                        tone: x.tone as Tone,
                        requiresApproval: x.requiresApproval,
                        isFinalNotice: x.isFinalNotice,
                      }))}
                    />
                    <p className="text-small text-ink-3">{describeCadence(s.steps.map((x) => x.offsetDays), s.kind)}</p>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 lg:col-start-1 lg:row-start-2">
                <Link href={`/sequences/${s.id}`} className={buttonClass("secondary", "sm")} aria-label={`Edit ${s.name}`}>Edit</Link>
                <DuplicateButton sequenceId={s.id} name={s.name} />
                {s.isDefault ? null : <MakeDefaultButton sequenceId={s.id} name={s.name} />}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
