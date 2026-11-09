// The 7-day strip on Next 7 days: one cell per day with its count and amount, today marked.
// Each cell jumps to that day's list. Server-rendered.
import { Money } from "@/components/money";
import { cx } from "@/components/ui";
import type { StripDay } from "@/lib/queries/ops";

export function WeekStrip({ days }: { days: StripDay[] }) {
  return (
    <nav aria-label="This week by day">
      <ol className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {days.map((day) => {
          const empty = day.count === 0;
          const cell = (
            <>
              <span className={cx("text-[12px] leading-4 font-medium", day.isToday ? "text-accent" : "text-ink-3")}>
                {day.isToday ? "Today" : day.weekday}
              </span>
              <span className={cx("num text-card-title", empty ? "text-ink-3" : "text-ink")}>{day.dayOfMonth}</span>
              <span className={cx("num text-small", empty ? "text-ink-3" : "font-medium text-ink")}>
                <span className="sm:hidden">{day.count}</span>
                <span className="max-sm:hidden">{empty ? "Nothing" : day.count === 1 ? "1 reminder" : `${day.count} reminders`}</span>
              </span>
              {day.totals.length > 0 ? (
                <span className="flex flex-col text-small text-ink-2 max-md:hidden">
                  {day.totals.map((t) => (
                    <Money key={t.currency} minor={t.amountMinor} currency={t.currency} />
                  ))}
                </span>
              ) : null}
            </>
          );
          const frame = cx(
            "flex h-full min-h-[4.75rem] flex-col items-center gap-0.5 rounded-[var(--radius-md)] border px-1 py-2.5 text-center sm:items-start sm:px-3 sm:text-left",
            day.isToday ? "border-accent/40 bg-accent-soft/60" : "border-line bg-surface",
            !empty && "lift hover:border-line-strong",
          );
          return (
            <li key={day.day}>
              {empty ? (
                <div className={frame}>
                  {cell}
                </div>
              ) : (
                <a href={`#day-${day.day}`} className={frame}>
                  {cell}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
