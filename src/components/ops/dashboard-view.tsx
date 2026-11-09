// Dashboard panels. Server-rendered; the only client parts are the inline row actions.
// Every money figure sits inside a per-currency group, so amounts in different currencies are
// never added together. The overdue total is the largest number on the page (DESIGN_V2).
import Link from "next/link";
import { ActionList, ActionRow, AgingBar, StatTile, Table, TBody, Td, Th, THead, Tr, type AgingBucket } from "@/components/data";
import { Money, MoneyList } from "@/components/money";
import { Badge, buttonClass, Card, cx, EmptyState } from "@/components/ui";
import type { ChaseState, CurrencyTotals, DashboardData, ReadyToChase } from "@/lib/queries/dashboard";
import { formatClock, formatDay, formatWhen, type NeedsYouRow } from "@/lib/queries/ops";
import type { ClientListItem } from "@/lib/engine";
import { OpsFeedback } from "./feedback";
import { hasQuickAction, KIND_BADGE, paymentPatternHeadline } from "./kinds";
import { RowQuickAction } from "./needs-you-card";

const CLIENT_ROWS_ON_DASHBOARD = 8;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Overdue headline --------------------------------------------------------------------

function agingBuckets(t: CurrencyTotals): AgingBucket[] {
  const c = t.counts;
  return [
    { label: `Not yet due (${c.notDue})`, amountMinor: t.notDueMinor, tone: "neutral" },
    { label: `1–30 days (${c.days1to30})`, amountMinor: t.overdueByAge.days1to30, tone: "warn" },
    { label: `31–60 days (${c.days31to60})`, amountMinor: t.overdueByAge.days31to60, tone: "warn" },
    { label: `61+ days (${c.days61plus})`, amountMinor: t.overdueByAge.days61plus, tone: "danger" },
  ];
}

function CurrencyOverdue({ totals, lead }: { totals: CurrencyTotals; lead: boolean }) {
  const overdue = totals.overdueMinor > 0;
  if (!lead) {
    // Other currencies: one compact line, with their own ageing from sm up.
    return (
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-small text-ink-2">
          <span className="w-9 font-medium text-ink-3">{totals.currency}</span>
          <Money minor={totals.overdueMinor} currency={totals.currency} className={cx("text-card-title", overdue ? "text-danger" : "text-ink")} />
          <span>overdue of</span>
          <Money minor={totals.outstandingMinor} currency={totals.currency} className="font-medium text-ink" />
        </p>
        {overdue ? (
          <div className="max-sm:hidden">
            <AgingBar buckets={agingBuckets(totals)} currency={totals.currency} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p
          className={cx(
            "num text-[40px] leading-[44px] font-semibold tracking-[-0.03em] sm:text-[48px] sm:leading-[52px]",
            overdue ? "text-danger" : "text-ink",
          )}
        >
          <Money minor={totals.overdueMinor} currency={totals.currency} />
        </p>
        <p className="mt-1 text-small text-ink-2">
          {overdue ? (
            <>
              {plural(totals.counts.overdue, "invoice", "invoices")} overdue, of{" "}
              <Money minor={totals.outstandingMinor} currency={totals.currency} className="font-medium text-ink" /> outstanding
            </>
          ) : (
            <>
              Nothing is overdue. <Money minor={totals.outstandingMinor} currency={totals.currency} className="font-medium text-ink" />{" "}
              outstanding, all due later.
            </>
          )}
        </p>
      </div>
      <AgingBar buckets={agingBuckets(totals)} currency={totals.currency} />
    </div>
  );
}

export function OverdueCard({ data, className }: { data: DashboardData; className?: string }) {
  const ordered = [...data.totals].sort((a, b) =>
    a.currency === data.primaryCurrency ? -1 : b.currency === data.primaryCurrency ? 1 : a.currency.localeCompare(b.currency),
  );
  return (
    <Card className={cx("flex flex-col gap-5 p-5 sm:p-6", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-card-title text-ink">Overdue</h2>
        <p className="text-small text-ink-3">
          As of <time dateTime={data.asOf}>{formatClock(data.asOf, data.timezone)}</time>
        </p>
      </div>
      {ordered.map((totals, i) => (
        <div key={totals.currency} className={cx(i === 1 && "border-t border-line pt-4")}>
          <CurrencyOverdue totals={totals} lead={i === 0} />
        </div>
      ))}
    </Card>
  );
}

// ---- Ready to chase ----------------------------------------------------------------------

const CHASE_REASON: Record<Exclude<ChaseState, "ready">, { label: string; href: string }> = {
  approval: { label: "Awaiting your approval", href: "/needs-you" },
  held: { label: "On hold (a reply or a bounce)", href: "/needs-you" },
  paused: { label: "Paused", href: "/invoices?status=paused" },
  disputed: { label: "Disputed", href: "/invoices?status=disputed" },
  ended: { label: "Sequence finished", href: "/invoices?status=open" },
};

export function ReadyToChaseCard({ ready, timezone, className }: { ready: ReadyToChase; timezone: string; className?: string }) {
  const queued = ready.states.find((s) => s.state === "ready");
  const blocked = ready.states.filter((s) => s.state !== "ready");
  return (
    <Card className={cx("flex flex-col p-5 sm:p-6", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-card-title text-ink">Ready to chase</h2>
        <Link href="/next-7-days" className="text-small font-medium text-accent underline-offset-4 hover:underline">
          Next 7 days
        </Link>
      </div>
      <p className="num mt-3 text-[28px] leading-8 font-semibold tracking-[-0.02em] text-ink">
        {queued ? <MoneyList amounts={queued.totals} className="justify-start" /> : "Nothing queued"}
      </p>
      <p className="mt-1 text-small text-ink-2">
        {queued ? (
          <>
            {plural(queued.invoices, "invoice has", "invoices have")} a reminder queued.
            {ready.nextSendAt ? (
              <>
                {" "}
                The next goes out <span className="font-medium text-ink">{formatWhen(ready.nextSendAt, timezone)}</span>.
              </>
            ) : null}
          </>
        ) : (
          "No unpaid invoice has a reminder waiting to go out."
        )}
      </p>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-small font-medium text-ink-2">Not being chased</h3>
        {blocked.length === 0 ? (
          <p className="mt-2 text-small text-ink-3">Every unpaid invoice has a reminder queued.</p>
        ) : (
          <ul className="mt-1 -mx-2">
            {blocked.map((s) => {
              const reason = CHASE_REASON[s.state as Exclude<ChaseState, "ready">];
              return (
                <li key={s.state}>
                  <Link
                    href={reason.href}
                    className="flex min-h-11 items-center justify-between gap-3 rounded-[8px] px-2 py-1.5 text-small transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-ink">{reason.label}</span>
                      <span className="num block text-ink-3">{plural(s.invoices, "invoice", "invoices")}</span>
                    </span>
                    <MoneyList amounts={s.totals} className="max-w-[60%] font-medium text-ink" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---- KPI tiles -----------------------------------------------------------------------------

function primaryAndOthers<T extends { currency: string }>(items: readonly T[], primary: string | null): { lead: T | null; rest: T[] } {
  const lead = items.find((t) => t.currency === primary) ?? items[0] ?? null;
  return { lead, rest: items.filter((t) => t !== lead) };
}

function StatTiles({ data }: { data: DashboardData }) {
  const { lead, rest } = primaryAndOthers(data.totals, data.primaryCurrency);
  const outstandingCount = data.totals.reduce((n, t) => n + t.counts.outstanding, 0);
  const dueWeekCount = data.totals.reduce((n, t) => n + t.counts.dueThisWeek, 0);
  const others = (pick: (t: CurrencyTotals) => number) =>
    rest.filter((t) => pick(t) > 0).map((t) => ({ amountMinor: pick(t), currency: t.currency }));
  const broken = (data.needsYou.byKind.failed ?? 0) + (data.needsYou.byKind.bounce ?? 0) + (data.needsYou.byKind.needs_check ?? 0);
  const approvals = data.needsYou.byKind.approval ?? 0;
  const needsSub =
    data.needsYou.total === 0
      ? "All caught up"
      : [broken > 0 ? `${broken} failed or bounced` : null, approvals > 0 ? `${approvals} to approve` : null]
          .filter(Boolean)
          .join(" · ") || plural(data.needsYou.total, "item", "items");

  const withOthers = (base: string, amounts: { amountMinor: number; currency: string }[]) =>
    amounts.length > 0 ? (
      <>
        {base} · also <MoneyList amounts={amounts} />
      </>
    ) : (
      base
    );

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 [&>*:nth-child(-n+2)]:max-sm:col-span-2">
      <StatTile
        label="Outstanding"
        href="/invoices"
        value={lead ? <Money minor={lead.outstandingMinor} currency={lead.currency} /> : "None"}
        sub={withOthers(plural(outstandingCount, "invoice", "invoices"), others((t) => t.outstandingMinor))}
      />
      <StatTile
        label="Due this week"
        href="/invoices?status=open"
        value={lead ? <Money minor={lead.dueThisWeekMinor} currency={lead.currency} /> : "None"}
        sub={withOthers(plural(dueWeekCount, "invoice", "invoices"), others((t) => t.dueThisWeekMinor))}
      />
      <StatTile
        label="Waiting for you"
        href="/needs-you"
        tone={broken > 0 ? "danger" : data.needsYou.total > 0 ? "warn" : "neutral"}
        value={data.needsYou.total}
        sub={needsSub}
      />
      <StatTile label="Reminders this week" href="/next-7-days" value={data.plannedNext7Days} sub="Planned for the next 7 days" />
    </div>
  );
}

// ---- Needs you preview -------------------------------------------------------------------

export function NeedsYouPreview({ total, preview }: { total: number; preview: NeedsYouRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="flex items-baseline gap-2 text-card-title text-ink">
          Needs you
          {total > 0 ? <span className="num text-small font-medium text-ink-3">{total}</span> : null}
        </h2>
        {total > 0 ? (
          <Link href="/needs-you" className={buttonClass("secondary", "sm")}>
            {total > preview.length ? `See all ${total}` : "Open Needs you"}
          </Link>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="px-4 py-6 text-body text-ink-2 sm:px-5">
          Nothing needs you. Failed sends, approvals, replies and bounces appear here first.
        </p>
      ) : (
        <OpsFeedback>
          <ActionList label="Most urgent items">
            {preview.map((row) => {
              const badge = KIND_BADGE[row.kind];
              return (
                <ActionRow
                  key={row.key}
                  href={`/needs-you?item=${encodeURIComponent(row.key)}`}
                  client={row.clientName ?? row.title}
                  title={row.line.title}
                  meta={row.line.meta}
                  amount={<MoneyList amounts={row.atStake} />}
                  status={<Badge tone={badge.tone}>{badge.label}</Badge>}
                  actions={hasQuickAction(row) ? <RowQuickAction row={row} /> : undefined}
                  tone={row.kind === "failed" || row.kind === "bounce" ? "danger" : undefined}
                />
              );
            })}
          </ActionList>
        </OpsFeedback>
      )}
    </Card>
  );
}

// ---- Clients -------------------------------------------------------------------------------

function daysToPayLabel(days: number | null): string {
  if (days === null) return "";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// The payment-pattern column. Null (an empty cell) when the client has no paid invoice yet.
export function paymentPatternCell(
  avgDaysLate: number | null,
  averageDaysToPay: number | null,
): { headline: string | null; secondary: string | null } {
  if (avgDaysLate === null) return { headline: null, secondary: null };
  return {
    headline: paymentPatternHeadline(avgDaysLate),
    secondary: averageDaysToPay === null ? null : `Average ${daysToPayLabel(averageDaysToPay)} to pay`,
  };
}

// The last-contact column. Null (an empty cell) when there has been no contact.
export function lastContactText(lastContactAt: Date | null, timezone: string): string | null {
  return lastContactAt ? formatDay(lastContactAt, timezone) : null;
}

export function ClientsTable({
  clients,
  timezone,
  oldestOverdueDays,
}: {
  clients: ClientListItem[];
  timezone: string;
  oldestOverdueDays: Record<string, number>;
}) {
  const shown = clients.slice(0, CLIENT_ROWS_ON_DASHBOARD);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="text-card-title text-ink">Clients</h2>
        <p className="text-small text-ink-3">Oldest overdue first</p>
        {clients.length > shown.length ? (
          <Link href="/clients" className="ml-auto text-small font-medium text-accent underline-offset-4 hover:underline">
            All {clients.length} clients
          </Link>
        ) : null}
      </div>
      <Table label="Clients, oldest overdue invoice first">
        <THead>
          <Th>Client</Th>
          <Th align="right">Overdue</Th>
          <Th>Oldest overdue</Th>
          <Th>Typically pays</Th>
          <Th>Last contact</Th>
        </THead>
        <TBody>
          {shown.map((client) => {
            const pattern = paymentPatternCell(client.avgDaysLate, client.averageDaysToPay);
            const overdue = client.overdue.filter((t) => t.amountMinor > 0);
            const days = oldestOverdueDays[client.id];
            return (
              <Tr key={client.id} href={`/clients/${client.id}`} tone={days !== undefined && days > 60 ? "danger" : undefined}>
                <Td primary>{client.name}</Td>
                <Td primary numeric>
                  {overdue.length > 0 ? <MoneyList amounts={overdue} className="text-ink" /> : null}
                </Td>
                <Td label="Oldest">
                  {days !== undefined ? <span className="text-danger">{plural(days, "day", "days")} overdue</span> : null}
                </Td>
                <Td label="Pays">{pattern.headline}</Td>
                <Td label="Last contact">{lastContactText(client.lastContactAt, timezone)}</Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

// Shown when no invoice exists yet. Says what to do next.
export function NoInvoicesYet() {
  return (
    <Card as="div">
      <EmptyState
        title="No invoices yet"
        body="Add your first invoice by hand, or import a CSV from your spreadsheet. Reminders are planned as soon as an invoice is open."
        action={
          <Link href="/invoices" className={buttonClass("primary")}>
            Add or import invoices
          </Link>
        }
      />
    </Card>
  );
}

export function DashboardBody({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      {data.totals.length === 0 ? (
        <Card className="p-5 sm:p-6 max-lg:order-1">
          <h2 className="text-card-title text-ink">Overdue</h2>
          <p className="num mt-3 text-[40px] leading-[44px] font-semibold text-ink">Nothing owed</p>
          <p className="mt-1 text-small text-ink-2">Every invoice is paid or closed.</p>
        </Card>
      ) : (
        <OverdueCard data={data} className="max-lg:order-1" />
      )}
      <ReadyToChaseCard ready={data.readyToChase} timezone={data.timezone} className="max-lg:order-3" />
      <div className="lg:col-span-2 max-lg:order-4">
        <StatTiles data={data} />
      </div>
      <div className="lg:col-span-2 max-lg:order-2">
        <NeedsYouPreview total={data.needsYou.total} preview={data.needsYou.preview} />
      </div>
      <div className="lg:col-span-2 max-lg:order-5">
        <ClientsTable clients={data.clients} timezone={data.timezone} oldestOverdueDays={data.oldestOverdueDays} />
      </div>
    </div>
  );
}
