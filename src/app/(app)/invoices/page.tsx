import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { AgingBar, SegmentedTabs, StatTile } from "@/components/data";
import { Money } from "@/components/money";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { InvoiceFilters } from "@/components/invoices/invoice-filters";
import { LinkButton } from "@/components/invoices/link-button";
import {
  computeRowData, InvoicesEmpty, InvoiceTable, listHref, showMoreHref, SORT_KEYS, sortRows,
  type InvoiceFilterValues, type InvoiceRowData, type SortKey,
} from "@/components/invoices/invoice-list";
import { pluralDays, todayIn } from "@/components/invoices/format";
import { listInvoices } from "@/lib/engine";
import { isUuidText } from "@/components/invoices/form-state";
import {
  listClientChoices, loadWorkspace, nextMessagesByInvoice, pendingApprovalCount, planProgressByInvoice, receivablesSummary,
  type ReceivablesSummary,
} from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Invoices" };

type SearchParams = Record<string, string | string[] | undefined>;

export default function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          <>
            <LinkButton href="/invoices/import" variant="secondary">Import CSV</LinkButton>
            <LinkButton href="/invoices/new" variant="primary">New invoice</LinkButton>
          </>
        }
      />
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 sm:mt-8 sm:gap-6">
        <Suspense fallback={<ListSkeleton />}>
          <InvoiceListSection searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

// The status tabs. Paused and Written off appear only when there is something in them.
const TABS: { key: string; label: string; optional?: boolean; match: (r: InvoiceRowData) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "overdue", label: "Overdue", match: (r) => r.overdueDays > 0 },
  { key: "open", label: "Open", match: (r) => r.invoice.status === "open" },
  { key: "payment_plan", label: "Plan", match: (r) => r.invoice.status === "payment_plan" },
  { key: "disputed", label: "Disputed", match: (r) => r.invoice.status === "disputed" },
  { key: "paused", label: "Paused", optional: true, match: (r) => r.invoice.status === "paused" },
  { key: "paid", label: "Paid", match: (r) => r.invoice.status === "paid" },
  { key: "written_off", label: "Written off", optional: true, match: (r) => r.invoice.status === "written_off" },
];

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function parseFilters(sp: SearchParams): InvoiceFilterValues & { tab: string; sortKey: SortKey | null; sortDir: "asc" | "desc"; cur: string } {
  const statusRaw = first(sp.status);
  const tab = TABS.some((t) => t.key === statusRaw) ? statusRaw : "all";
  const clientRaw = first(sp.client);
  const clientId = isUuidText(clientRaw) ? clientRaw : "";
  const q = first(sp.q).trim().slice(0, 100);
  const limitRaw = Number.parseInt(first(sp.limit), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 50), 500) : 50;
  const sortRaw = first(sp.sort);
  const sortKey = (SORT_KEYS as readonly string[]).includes(sortRaw) ? (sortRaw as SortKey) : null;
  const sortDir = first(sp.dir) === "desc" ? "desc" : "asc";
  const cur = /^[A-Z]{3}$/.test(first(sp.cur)) ? first(sp.cur) : "";
  return {
    status: tab === "all" ? "" : tab, clientId, q, limit,
    sort: sortKey ?? undefined, dir: sortKey ? sortDir : undefined,
    tab, sortKey, sortDir, cur,
  };
}

// Reads the session and the data, so it sits behind the Suspense boundary above.
// Every matching invoice is loaded and sorted here, so overdue ones are never cut off by the page size.
async function InvoiceListSection({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const f = parseFilters(sp);
  const [workspace, clients, matching] = await Promise.all([
    loadWorkspace(userId),
    listClientChoices(userId),
    listInvoices(userId, { clientId: f.clientId || undefined, search: f.q || undefined, limit: 2000 }),
  ]);
  const today = todayIn(workspace.zone);
  const ids = matching.map((i) => i.id);
  const [next, plans, summary, pending] = await Promise.all([
    nextMessagesByInvoice(userId, ids),
    planProgressByInvoice(userId, ids),
    receivablesSummary(userId, today),
    pendingApprovalCount(userId),
  ]);
  const all = matching.map((inv) =>
    computeRowData(inv, {
      today, zone: workspace.zone, profileComplete: workspace.profileComplete, onboardingDone: workspace.onboardingDone,
      next, dues: new Map(), plans,
    }),
  );

  const tab = TABS.find((t) => t.key === f.tab) ?? TABS[0];
  const counts = new Map(TABS.map((t) => [t.key, all.filter(t.match).length]));
  const inTab = sortRows(all.filter(tab.match), f.sortKey, f.sortDir);
  const rows = inTab.slice(0, f.limit);
  const hasMore = inTab.length > f.limit;
  const values: InvoiceFilterValues & { cur?: string } = {
    status: f.status, clientId: f.clientId, q: f.q, limit: f.limit, sort: f.sort, dir: f.dir, cur: f.cur || undefined,
  };
  const filtered = Boolean(f.clientId || f.q || f.tab !== "all");

  const tabItems = TABS.filter((t) => !t.optional || (counts.get(t.key) ?? 0) > 0 || t.key === f.tab).map((t) => ({
    label: t.label,
    href: listHref({ ...values, sort: undefined, dir: undefined }, { status: t.key, limit: null }),
    count: counts.get(t.key) ?? 0,
    active: t.key === f.tab,
  }));

  const sort = {
    key: f.sortKey,
    dir: f.sortDir,
    hrefFor: (key: SortKey) =>
      listHref(values, { sort: key, dir: f.sortKey === key && f.sortDir === "asc" ? "desc" : "asc", limit: null }),
  };

  return (
    <>
      {summary.length > 0 ? <Receivables summary={summary} selected={f.cur} values={values} pending={pending} /> : null}

      <section aria-label="Invoice list" className="grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <SegmentedTabs label="Invoice status" items={tabItems} />
          </div>
          <InvoiceFilters values={values} clients={clients} />
        </div>
        {rows.length === 0 ? (
          <InvoicesEmpty filtered={filtered} tabLabel={f.tab !== "all" ? tab.label : undefined} />
        ) : (
          <>
            <InvoiceTable rows={rows} sort={sort} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="num text-small text-ink-3">
                {hasMore ? `Showing ${rows.length} of ${inTab.length} invoices` : `${inTab.length} ${inTab.length === 1 ? "invoice" : "invoices"}`}
              </p>
              {hasMore ? <LinkButton href={showMoreHref(values)} variant="secondary" size="sm">Show 50 more</LinkButton> : null}
            </div>
          </>
        )}
      </section>
    </>
  );
}

// Three buckets, so each has its own colour: not yet due, recently overdue, long overdue.
function bucketsOf(s: ReceivablesSummary) {
  return [
    { label: "Not yet due", tone: "neutral" as const, amountMinor: s.buckets.notDue },
    { label: "1–30 days overdue", tone: "warn" as const, amountMinor: s.buckets.upTo30 },
    { label: "Over 30 days overdue", tone: "danger" as const, amountMinor: s.buckets.upTo90 + s.buckets.older },
  ];
}

// The receivables summary: three figures and the ageing bar, in one currency at a time.
// Amounts in different currencies are never added together.
function Receivables({
  summary,
  selected,
  values,
  pending,
}: {
  summary: ReceivablesSummary[];
  selected: string;
  values: InvoiceFilterValues & { cur?: string };
  pending: number;
}) {
  const current = summary.find((s) => s.currency === selected) ?? summary[0];
  const cur = current.currency;
  const count = (n: number) => `${n} ${n === 1 ? "invoice" : "invoices"}`;
  return (
    <section aria-labelledby="receivables-heading" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="receivables-heading" className="text-section-title text-ink">
          Money owed to you{summary.length > 1 ? <span className="sr-only"> in {cur}</span> : null}
        </h2>
        {summary.length > 1 ? (
          <SegmentedTabs
            label="Currency"
            items={summary.map((s) => ({
              label: s.currency,
              href: listHref(values, { cur: s.currency, limit: null }),
              active: s.currency === cur,
            }))}
          />
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-[repeat(3,minmax(0,1fr))]">
        <div className="col-span-2 lg:col-span-1">
          <StatTile
            label="Overdue"
            tone={current.overdueMinor > 0 ? "danger" : "neutral"}
            value={<Money minor={current.overdueMinor} currency={cur} />}
            sub={current.overdueCount > 0 ? `${count(current.overdueCount)} · oldest ${pluralDays(current.oldestOverdueDays)}` : "Nothing is overdue"}
            href={listHref({ ...values, sort: undefined, dir: undefined }, { status: "overdue", limit: null })}
          />
        </div>
        <StatTile
          label="Outstanding"
          value={<Money minor={current.outstandingMinor} currency={cur} />}
          sub={count(current.outstandingCount)}
        />
        <StatTile
          label="Due in the next 7 days"
          value={<Money minor={current.dueSoonMinor} currency={cur} />}
          sub={current.dueSoonCount > 0 ? count(current.dueSoonCount) : "Nothing due"}
        />
      </div>
      <Card className="grid gap-3 p-4 max-sm:hidden sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-card-title text-ink">Ageing</h3>
          {pending > 0 ? (
            <Link href="/needs-you" className="text-small font-medium text-accent underline-offset-4 hover:underline">
              {pending} {pending === 1 ? "reminder waits" : "reminders wait"} for your approval
            </Link>
          ) : null}
        </div>
        <AgingBar
          currency={cur}
          buckets={bucketsOf(current)}
        />
      </Card>
    </section>
  );
}
