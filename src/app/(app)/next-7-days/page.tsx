import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, Suspense } from "react";
import { ActionList } from "@/components/data";
import { MoneyList } from "@/components/money";
import { OpsFeedback } from "@/components/ops/feedback";
import { ScheduleRow } from "@/components/ops/schedule-row";
import { ListSkeleton } from "@/components/ops/skeletons";
import { WeekStrip } from "@/components/ops/week-strip";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/ui";
import { systemClock } from "@/lib/clock";
import { loadNextSevenDays, type NextSevenDaysGroup } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Next 7 days" };

export default function NextSevenDaysPage() {
  return (
    <>
      <PageHeader title="Next 7 days" description="Every reminder planned for this week. Approve, hold, edit or cancel any of them before it goes." />
      <div className="mt-6">
        <Suspense fallback={<ListSkeleton rows={4} />}>
          <Schedule />
        </Suspense>
      </div>
    </>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Reminders in a day grouped by send time, so a time is shown once, not on every row.
function byTime(group: NextSevenDaysGroup) {
  const times = new Map<string, NextSevenDaysGroup["reminders"]>();
  for (const r of group.reminders) times.set(r.timeLabel, [...(times.get(r.timeLabel) ?? []), r]);
  return [...times.entries()];
}

function dayTotals(group: NextSevenDaysGroup) {
  const totals = new Map<string, number>();
  for (const r of group.reminders) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMinor);
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

async function Schedule() {
  const userId = await requireUserId();
  const view = await loadNextSevenDays(userId, systemClock);
  const awaiting = view.groups.reduce((n, g) => n + g.reminders.filter((r) => r.status === "pending_approval").length, 0);

  if (view.count === 0) {
    return (
      <Card as="div">
        <EmptyState
          title="Nothing is planned this week"
          body="Reminders show up here when an open invoice has a step due in the next seven days. Add or import invoices to fill the schedule."
          action={
            <Link href="/invoices" className={buttonClass("primary")}>
              Go to invoices
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <OpsFeedback>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className="text-small text-ink-2">
            <span className="num font-medium text-ink">{plural(view.count, "reminder", "reminders")}</span>
            {awaiting > 0 ? (
              <>
                , <span className="num font-medium text-warn">{awaiting} awaiting approval</span>
              </>
            ) : null}
            . Times are in {view.timezone.replace(/_/g, " ")}.
          </p>
          <WeekStrip days={view.days} />
        </div>

        <Card className="overflow-hidden">
          <ActionList label="Reminders planned this week">
            {view.groups.map((group) => {
              const times = byTime(group);
              const single = times.length === 1 ? times[0][0] : null;
              return (
                <Fragment key={group.day}>
                  <div
                    id={`day-${group.day}`}
                    className="col-span-full flex scroll-mt-6 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-surface-2 px-4 py-3 sm:px-5"
                  >
                    <h2 className="text-card-title text-ink">
                      {group.label}
                      {!/\d/.test(group.label) ? <span className="font-normal text-ink-3"> · {group.dateLabel}</span> : null}
                    </h2>
                    <p className="flex flex-wrap items-baseline gap-x-2 text-small text-ink-2">
                      {single ? <span className="num">Sends at {single}</span> : null}
                      {single ? <span aria-hidden="true" className="text-ink-3">·</span> : null}
                      <span className="num">{plural(group.reminders.length, "reminder", "reminders")}</span>
                      <span aria-hidden="true" className="text-ink-3">·</span>
                      <MoneyList amounts={dayTotals(group)} className="font-medium text-ink" />
                    </p>
                  </div>
                  {times.map(([time, reminders]) => (
                    <Fragment key={time}>
                      {single ? null : (
                        <p className="num col-span-full border-b border-line px-4 py-2 text-small font-medium text-ink-2 sm:px-5">
                          Sends at {time}
                        </p>
                      )}
                      {reminders.map((reminder) => (
                        <ScheduleRow key={reminder.id} reminder={reminder} />
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              );
            })}
          </ActionList>
        </Card>
      </div>
    </OpsFeedback>
  );
}
