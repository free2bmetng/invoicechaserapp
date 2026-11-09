// The payment-plan schedule: progress first (what is paid, what is left), then each installment
// with one clear mark: paid on a date, overdue, next, or due later. Every amount carries its currency.
import { ProgressBar } from "@/components/data";
import { Badge, cx } from "@/components/ui";
import { Money } from "@/components/money";
import type { InstallmentView } from "@/lib/engine";
import { formatMoney } from "@/lib/money";
import { DateTime } from "luxon";
import { dueDateLabel } from "./format";
import { dueWhen } from "./status-model";

export function PlanSchedule({
  installments,
  currency,
  totalMinor,
  today,
  zone,
}: {
  installments: InstallmentView[];
  currency: string;
  totalMinor: number;
  today: string;
  zone: string;
}) {
  const paid = installments.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amountMinor, 0);
  const nextOpen = installments.find((i) => i.status === "open") ?? null;
  const paidCount = installments.filter((i) => i.status === "paid").length;
  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <p className="text-body text-ink-2">
          <Money minor={paid} currency={currency} className="text-[20px] font-semibold text-ink" />
          <span className="ml-1.5">paid of {formatMoney(totalMinor, currency)}</span>
          <span className="text-ink-3"> · <Money minor={totalMinor - paid} currency={currency} /> to go</span>
        </p>
        <ProgressBar value={paid} max={totalMinor} label={`${paidCount} of ${installments.length} installments paid`} />
      </div>

      <ol className="divide-y divide-line rounded-[var(--radius-md)] border border-line" aria-label="Installments">
        {installments.map((inst) => {
          const isNext = nextOpen?.id === inst.id;
          const when = inst.status === "open" ? dueWhen(inst.dueDate, today) : null;
          return (
            <li key={inst.id} className={cx("grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-3 sm:grid-cols-[1.75rem_9rem_minmax(0,1fr)_auto] sm:px-4", isNext && "bg-accent-soft/40")}>
              <span
                aria-hidden="true"
                className={cx(
                  "grid size-6 place-items-center rounded-full text-[11px] font-semibold",
                  inst.status === "paid" ? "bg-ok-fill text-white" : isNext ? "bg-accent text-accent-ink" : "border border-line-strong text-ink-3",
                )}
              >
                {inst.status === "paid" ? (
                  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.3 4.9 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : (
                  inst.position
                )}
              </span>
              <span className="num text-body text-ink">
                <span className="sr-only">Installment {inst.position}, due </span>
                {dueDateLabel(inst.dueDate)}
              </span>
              <span className="col-start-2 row-start-2 text-small sm:col-start-3 sm:row-start-1">
                {inst.status === "paid" ? (
                  <span className="text-ok">Paid{inst.paidAt ? ` ${DateTime.fromJSDate(inst.paidAt).setZone(zone).setLocale("en").toFormat("d LLL yyyy")}` : ""}</span>
                ) : when && when.overdueDays > 0 ? (
                  <span className="font-medium text-danger">{when.text}</span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    {isNext ? <Badge tone="accent">Next</Badge> : null}
                    <span className={when?.tone === "warn" ? "font-medium text-warn" : "text-ink-3"}>{when?.text}</span>
                  </span>
                )}
              </span>
              <Money minor={inst.amountMinor} currency={inst.currency} className={cx("col-start-3 row-span-2 text-right text-body font-medium sm:col-start-4 sm:row-span-1", inst.status === "paid" ? "text-ink-3" : "text-ink")} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
