import { Suspense } from "react";
import type { Metadata } from "next";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { LinkButton } from "@/components/invoices/link-button";
import { AddClientForm } from "@/components/clients/add-client-form";
import { ClientSearch } from "@/components/clients/client-search";
import { ClientTable, clientsHref } from "@/components/clients/client-list";
import { MoneyList } from "@/components/money";
import { listClients, type MoneyTotal } from "@/lib/engine";
import { loadWorkspace } from "@/lib/queries/invoices";
import { systemClock } from "@/lib/clock";
import { requireUserId } from "@/lib/session";
import { SegmentedTabs } from "@/components/data";
import { FIRST_DIR, filterClients, parseClientSort, sortClients, type ClientSortKey } from "./client-data";

const PHONE_SORTS: { key: ClientSortKey; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "outstanding", label: "Outstanding" },
  { key: "name", label: "Name" },
  { key: "contact", label: "Last contact" },
];

export const metadata: Metadata = { title: "Clients" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function ClientsPage({ searchParams }: { searchParams: Search }) {
  return (
    <>
      <PageHeader
        title="Clients"
        description="Who owes you, how quickly each client pays, and when you last chased them."
        actions={<LinkButton href="/clients?add=1" variant="primary">Add client</LinkButton>}
      />
      <div className="mt-6 grid gap-4">
        <Suspense fallback={<ListSkeleton />}>
          <ClientsSection searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function sum(rows: MoneyTotal[][]): MoneyTotal[] {
  const by = new Map<string, number>();
  for (const totals of rows) for (const t of totals) by.set(t.currency, (by.get(t.currency) ?? 0) + t.amountMinor);
  return [...by].filter(([, v]) => v > 0).map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((a, b) => b.amountMinor - a.amountMinor);
}

// Reads the session, the query string and the data, so it sits behind the Suspense boundary above.
async function ClientsSection({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").slice(0, 100);
  const sort = parseClientSort(one(sp.sort), one(sp.dir));
  const adding = one(sp.add) === "1";
  const userId = await requireUserId();
  const [clients, workspace] = await Promise.all([listClients(userId, systemClock), loadWorkspace(userId)]);
  const shown = sortClients(filterClients(clients, q), sort.key, sort.dir);
  const explicitSort = one(sp.sort) ? sort : null;
  const overdueTotal = sum(clients.map((c) => c.overdue));
  const overdueCount = clients.filter((c) => c.overdue.some((t) => t.amountMinor > 0)).length;

  const addForm = (
    <Card className="p-4 sm:p-6">
      <h2 className="text-card-title text-ink">Add a client</h2>
      <p className="mt-0.5 mb-4 text-small text-ink-3">Add their invoices next, and reminders are planned from each due date.</p>
      <AddClientForm cancelHref={clients.length === 0 ? null : clientsHref({ q, sort: explicitSort?.key, dir: explicitSort?.dir })} />
    </Card>
  );

  if (clients.length === 0) {
    return (
      <>
        {addForm}
        <EmptyState
          title="No clients yet"
          body="Clients also appear when you add an invoice or import a CSV of open invoices."
          action={<LinkButton href="/invoices/import" variant="secondary">Import a CSV</LinkButton>}
        />
      </>
    );
  }

  return (
    <>
      {adding ? addForm : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ClientSearch q={q} sort={explicitSort?.key} dir={explicitSort?.dir} />
        <p className="text-small text-ink-3">
          <span className="num">{clients.length}</span> {clients.length === 1 ? "client" : "clients"}
          {overdueCount > 0 ? (
            <>
              {" · "}
              <span className="num">{overdueCount}</span> overdue, <MoneyList amounts={overdueTotal} className="font-medium text-danger" />
            </>
          ) : null}
        </p>
      </div>
      <div className="sm:hidden">
        <SegmentedTabs
          label="Sort clients"
          items={PHONE_SORTS.map((o) => ({
            label: o.label,
            href: clientsHref({ q, sort: o.key, dir: FIRST_DIR[o.key] }),
            active: sort.key === o.key,
          }))}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={`No clients match “${q}”`}
          body="Search looks at client names and email addresses."
          action={<LinkButton href={clientsHref({ sort: explicitSort?.key, dir: explicitSort?.dir })} variant="secondary">Clear search</LinkButton>}
        />
      ) : (
        <ClientTable clients={shown} zone={workspace.zone} sort={sort} q={q} />
      )}
    </>
  );
}
