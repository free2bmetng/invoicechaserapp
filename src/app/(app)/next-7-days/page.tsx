import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { OpsFeedback } from "@/components/ops/feedback";
import { LINK_BUTTON_PRIMARY, LINK_BUTTON_SECONDARY } from "@/components/ops/kinds";
import { ScheduleRow } from "@/components/ops/schedule-row";
import { ListSkeleton } from "@/components/ops/skeletons";
import { EmptyState, PageHeader } from "@/components/ui";
import { systemClock } from "@/lib/clock";
import { loadNextSevenDays } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Next 7 days" };

export default function NextSevenDaysPage() {
  return (
    <>
      <PageHeader
        eyebrow="Schedule"
        title="Next 7 days"
        description="Every reminder planned for the next seven days, in your timezone. Hold, resume, cancel or edit any of them."
      />
      <div className="mt-8">
        <Suspense fallback={<ListSkeleton rows={4} />}>
          <Schedule />
        </Suspense>
      </div>
    </>
  );
}

async function Schedule() {
  const userId = await requireUserId();
  const view = await loadNextSevenDays(userId, systemClock);

  return (
    <OpsFeedback>
      {view.count === 0 ? (
        <EmptyState
          title="Nothing is planned this week"
          body="Reminders show up here when an open invoice has a step due in the next seven days. Add or import invoices to fill the schedule."
          action={
            <Link href="/invoices" className={LINK_BUTTON_PRIMARY}>
              Go to invoices
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[14px] text-ink-2">
              <span className="num font-semibold text-ink">{view.count}</span> reminder{view.count === 1 ? "" : "s"} · times shown in{" "}
              {view.timezone}
            </p>
            <Link href="/needs-you" className={LINK_BUTTON_SECONDARY}>
              Open Needs you
            </Link>
          </div>
          {view.groups.map((group) => (
            <section key={group.day} aria-labelledby={`day-${group.day}`} className="flex flex-col gap-3">
              <h2 id={`day-${group.day}`} className="flex items-baseline gap-2 text-[16px] font-semibold text-ink">
                {group.label}
                <span className="num text-[13px] font-medium text-ink-3">{group.reminders.length}</span>
              </h2>
              <ul className="divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface shadow-card">
                {group.reminders.map((reminder) => (
                  <ScheduleRow key={reminder.id} reminder={reminder} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </OpsFeedback>
  );
}
