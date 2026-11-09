// Dashboard panels. Server-rendered; no client state. Every money figure sits inside a
// per-currency group, so amounts in different currencies are never added together.
import Link from "next/link";
import { Money } from "@/components/money";
import { Badge, cx, EmptyState } from "@/components/ui";
import type { CurrencyTotals, DashboardData } from "@/lib/queries/dashboard";
import { formatDay, type NeedsYouRow } from "@/lib/queries/ops";
import type { ClientListItem } from "@/lib/engine";
import { KIND_BADGE, LINK_BUTTON_PRIMARY, LINK_BUTTON_SECONDARY, paymentPatternHeadline } from "./kinds";

const CLIENT_ROWS_ON_DASHBOARD = 8;

export function CurrencyTotalsCard({ totals, className }: { totals: CurrencyTotals; className?: string }) {
  const { currency, overdueMinor, overdueByAge } = totals;
  const segments = [
    { label: "1–30 days", minor: overdueByAge.days1to30, bar: "bg-warn/40" },
    { label: "31–60 days", minor: overdueByAge.days31to60, bar: "bg-warn/75" },
    { label: "61+ days", minor: overdueByAge.days61plus, bar: "bg-danger" },
  ];
  return (
    <section
      aria-labelledby={`totals-${currency}`}
      className={cx("rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:p-6", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`totals-${currency}`} className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
          {currency}
        </h2>
      </div>
      <dl className="mt-4 grid gap-6 sm:grid-cols-2">
        <div>
          <dt className="text-[13px] text-ink-2">Outstanding</dt>
          <dd className="mt-1 text-[28px] leading-9 font-semibold tracking-[-0.02em] text-ink">
            <Money minor={totals.outstandingMinor} currency={currency} />
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-2">Overdue</dt>
          <dd className="mt-1 text-[28px] leading-9 font-semibold tracking-[-0.02em] text-warn">
            <Money minor={overdueMinor} currency={currency} />
          </dd>
        </div>
      </dl>

      {overdueMinor > 0 ? (
        <div className="mt-6">
          <div aria-hidden="true" className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2">
            {segments.map((segment) =>
              segment.minor > 0 ? (
                <span key={segment.label} className={segment.bar} style={{ width: `${(segment.minor / overdueMinor) * 100}%` }} />
              ) : null,
            )}
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-3">
            {segments.map((segment) => (
              <li key={segment.label} className="flex items-center justify-between gap-3 rounded-[10px] bg-surface-2 px-3 py-2 text-[13px]">
                <span className="whitespace-nowrap text-ink-2">{segment.label}</span>
                <Money minor={segment.minor} currency={currency} className="text-ink" />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-6 text-[14px] text-ink-2">Nothing is overdue in {currency}.</p>
      )}
    </section>
  );
}

export function NeedsYouPanel({ total, preview }: { total: number; preview: NeedsYouRow[] }) {
  return (
    <section aria-labelledby="dash-needs" className="flex flex-col rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id="dash-needs" className="text-[16px] font-semibold text-ink">
          Needs you
        </h2>
        {total > 0 ? <Badge tone="warn">{total} waiting</Badge> : null}
      </div>
      {total === 0 ? (
        <EmptyState
          title="Nothing needs you"
          body="Reminders waiting for approval, failed sends, client replies and bounces appear here."
        />
      ) : (
        <>
          <ul className="mt-4 divide-y divide-line">
            {preview.map((row) => {
              const badge = KIND_BADGE[row.kind];
              const meta = row.reminder
                ? [row.reminder.stepLabel, row.plannedLabel ? `planned ${row.plannedLabel}` : null].filter(Boolean).join(" · ")
                : row.detail;
              return (
                <li key={row.key} className="flex flex-col gap-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>
                  <p className="text-[14px] leading-6 font-medium text-ink">{row.title}</p>
                  <p className="text-[13px] leading-5 text-ink-2">{meta}</p>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
            <p className="text-[13px] text-ink-3">
              {total > preview.length ? `Showing ${preview.length} of ${total}.` : `${total} item${total === 1 ? "" : "s"}.`}
            </p>
            <Link href="/needs-you" className={LINK_BUTTON_SECONDARY}>
              Open Needs you
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

export function NextSevenDaysPanel({ planned }: { planned: number }) {
  return (
    <section
      aria-labelledby="dash-next7"
      className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
      <div className="min-w-0">
        <h2 id="dash-next7" className="text-[16px] font-semibold text-ink">
          Next 7 days
        </h2>
        {planned === 0 ? (
          <p className="mt-1 text-[14px] leading-6 text-ink-2">
            No reminders are planned this week. They appear here once an open invoice has a step due.
          </p>
        ) : (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num text-[32px] leading-none font-semibold tracking-[-0.03em] text-ink">{planned}</span>
            <span className="text-[14px] leading-6 text-ink-2">
              {planned === 1 ? "reminder is" : "reminders are"} planned in the next seven days, in your timezone.
            </span>
          </p>
        )}
      </div>
      <Link href="/next-7-days" className={`${LINK_BUTTON_SECONDARY} self-start sm:self-auto`}>
        Review the week
      </Link>
    </section>
  );
}

function daysToPayLabel(days: number | null): string {
  if (days === null) return "";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function OverdueList({ totals }: { totals: ClientListItem["overdue"] }) {
  const nonZero = totals.filter((t) => t.amountMinor > 0);
  if (nonZero.length === 0) return <span className="text-ink-3">–</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {nonZero.map((t) => (
        <Money key={t.currency} minor={t.amountMinor} currency={t.currency} className="text-warn" />
      ))}
    </span>
  );
}

// The payment-pattern column. A single dash when the client has no paid invoice yet.
export function paymentPatternCell(
  avgDaysLate: number | null,
  averageDaysToPay: number | null,
): { headline: string; secondary: string | null } {
  if (avgDaysLate === null) return { headline: "–", secondary: null };
  return {
    headline: paymentPatternHeadline(avgDaysLate),
    secondary: averageDaysToPay === null ? null : `Average ${daysToPayLabel(averageDaysToPay)} to pay`,
  };
}

// The last-contact column. A single dash when there has been no contact.
export function lastContactText(lastContactAt: Date | null, timezone: string): string {
  return lastContactAt ? formatDay(lastContactAt, timezone) : "–";
}

export function ClientsPanel({ clients, timezone, totalClients }: { clients: ClientListItem[]; timezone: string; totalClients: number }) {
  const shown = clients.slice(0, CLIENT_ROWS_ON_DASHBOARD);
  return (
    <section aria-labelledby="dash-clients" className="rounded-[var(--radius-lg)] border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div>
          <h2 id="dash-clients" className="text-[16px] font-semibold text-ink">
            Clients
          </h2>
          <p className="text-[13px] text-ink-3">Ordered by the oldest overdue invoice. Overdue amounts are per currency.</p>
        </div>
        {totalClients > shown.length ? (
          <Link href="/clients" className="inline-flex min-h-11 items-center text-[14px] font-medium text-accent underline-offset-4 hover:underline">
            View all {totalClients} clients
          </Link>
        ) : null}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
          <thead>
            <tr className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              <th scope="col" className="px-6 py-3 font-semibold">Client</th>
              <th scope="col" className="px-4 py-3 font-semibold">Payment pattern</th>
              <th scope="col" className="px-4 py-3 font-semibold">Overdue</th>
              <th scope="col" className="px-6 py-3 font-semibold">Last contact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((client) => {
              const pattern = paymentPatternCell(client.avgDaysLate, client.averageDaysToPay);
              return (
                <tr key={client.id} className="align-top">
                  <th scope="row" className="px-6 py-3.5 font-medium text-ink">
                    <Link href={`/clients/${client.id}`} className="underline-offset-4 hover:underline">
                      {client.name}
                    </Link>
                  </th>
                  <td className="px-4 py-3.5 text-ink-2">
                    <span className="block font-medium text-ink">{pattern.headline}</span>
                    {pattern.secondary ? <span className="num block text-[13px] text-ink-3">{pattern.secondary}</span> : null}
                  </td>
                  <td className="px-4 py-3.5"><OverdueList totals={client.overdue} /></td>
                  <td className="px-6 py-3.5 text-ink-2">{lastContactText(client.lastContactAt, timezone)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-line md:hidden">
        {shown.map((client) => {
          const pattern = paymentPatternCell(client.avgDaysLate, client.averageDaysToPay);
          const detail = [pattern.secondary, lastContactText(client.lastContactAt, timezone)].filter(Boolean).join(" · ");
          return (
            <li key={client.id} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-2.5">
              <Link href={`/clients/${client.id}`} className="inline-flex min-h-11 min-w-0 items-center truncate text-[15px] font-medium text-ink underline-offset-4 hover:underline">
                {client.name}
              </Link>
              <span className="text-right text-[14px]">
                <OverdueList totals={client.overdue} />
              </span>
              <span className="col-span-2 text-[14px] leading-6 font-medium text-ink">{pattern.headline}</span>
              <span className="col-span-2 text-[13px] leading-5 text-ink-3">{detail}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Shown when no invoice exists yet. Says what to do next.
export function NoInvoicesYet() {
  return (
    <EmptyState
      title="No invoices yet"
      body="Add your first invoice by hand, or import a CSV from your spreadsheet. Reminders are planned as soon as an invoice is open."
      action={
        <Link href="/invoices" className={LINK_BUTTON_PRIMARY}>
          Add or import invoices
        </Link>
      }
    />
  );
}

export function DashboardBody({ data }: { data: DashboardData }) {
  const oddCount = data.totals.length % 2 === 1;
  return (
    <div className="flex flex-col gap-6">
      <NeedsYouPanel total={data.needsYou.total} preview={data.needsYou.preview} />
      <NextSevenDaysPanel planned={data.plannedNext7Days} />
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">Money owed</h2>
          <p className="mt-1 text-[13px] text-ink-3">Shown per currency. Amounts in different currencies are never added together.</p>
        </div>
        {data.totals.length === 0 ? (
          <EmptyState title="Nothing is owed right now" body="Outstanding amounts appear here as soon as an invoice is open and unpaid." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.totals.map((totals, index) => {
              const isLast = index === data.totals.length - 1;
              return (
                <CurrencyTotalsCard key={totals.currency} totals={totals} className={oddCount && isLast ? "lg:col-span-2" : undefined} />
              );
            })}
          </div>
        )}
      </div>
      <ClientsPanel clients={data.clients} timezone={data.timezone} totalClients={data.clients.length} />
    </div>
  );
}
