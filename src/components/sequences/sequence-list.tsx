// The sequences list. Server-rendered: each card links to its editor.
import Link from "next/link";
import { Badge } from "@/components/ui";
import type { SequenceView } from "@/lib/engine";
import { describeCadence } from "./state";
import { MakeDefaultButton } from "./sequence-actions";

export function SequenceCards({ sequences, usage }: { sequences: SequenceView[]; usage: Map<string, number> }) {
  return (
    <ul aria-label="Sequences" className="grid gap-4">
      {sequences.map((s) => {
        const count = usage.get(s.id) ?? 0;
        const isPlan = s.kind === "plan";
        const offsets = s.steps.map((x) => x.offsetDays);
        return (
          <li key={s.id} className="grid gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-6">
            <div className="grid min-w-0 gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/sequences/${s.id}`} className="text-[16px] font-semibold text-ink underline-offset-4 hover:underline">
                  {s.name}
                </Link>
                {s.isDefault ? <Badge tone="accent">Default</Badge> : null}
              </div>
              <p className="text-[13.5px] leading-6 text-ink-2">{describeCadence(offsets, s.kind)}</p>
              <p className="num text-[13px] text-ink-3">
                {isPlan
                  ? `${count} payment ${count === 1 ? "plan uses" : "plans use"} the default`
                  : `${count} open ${count === 1 ? "invoice uses" : "invoices use"} this sequence`}
              </p>
            </div>
            <div className="grid justify-items-start gap-3 sm:justify-items-end">
              <Link
                href={`/sequences/${s.id}`}
                className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink shadow-card hover:border-ink-3 hover:bg-surface-2 sm:h-9 sm:px-3.5 sm:text-[13.5px]"
              >
                Edit
              </Link>
              {s.isDefault ? null : <MakeDefaultButton sequenceId={s.id} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
