import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { InvoiceFilters } from "@/components/invoices/invoice-filters";
import { LinkButton } from "@/components/invoices/link-button";
import {
  compareRows, computeRowData, InvoiceRows, InvoicesEmpty, showMoreHref, SummaryLine, type InvoiceFilterValues,
} from "@/components/invoices/invoice-list";
import { todayIn } from "@/components/invoices/format";
import { listInvoices } from "@/lib/engine";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/types";
import { isUuidText } from "@/components/invoices/form-state";
import {
  listClientChoices, loadWorkspace, nextMessagesByInvoice, openInstallmentDues, overdueByCurrency, pendingApprovalCount,
} from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Invoices" };

type SearchParams = Record<string, string | string[] | undefined>;

export default function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every invoice, its status, and what happens next."
        actions={
          <>
            <LinkButton href="/invoices/import" variant="secondary">Import CSV</LinkButton>
            <LinkButton href="/invoices/new" variant="primary">New invoice</LinkButton>
          </>
        }
      />
      <div className="mt-8 grid gap-6">
        <Suspense fallback={<ListSkeleton />}>
          <InvoiceListSection searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function parseFilters(sp: SearchParams): InvoiceFilterValues & { statusValue: InvoiceStatus | undefined; clientValue: string | undefined } {
  const statusRaw = first(sp.status);
  const status = (INVOICE_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as InvoiceStatus) : undefined;
  const clientRaw = first(sp.client);
  const clientId = isUuidText(clientRaw) ? clientRaw : "";
  const q = first(sp.q).trim().slice(0, 100);
  const limitRaw = Number.parseInt(first(sp.limit), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 50), 500) : 50;
  return { status: status ?? "", clientId, q, limit, statusValue: status, clientValue: clientId || undefined };
}

// Reads the session and the data, so it sits behind the Suspense boundary above.
// Every matching invoice is loaded and sorted here, so overdue ones are never cut off by the page size.
async function InvoiceListSection({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [workspace, clients, matching] = await Promise.all([
    loadWorkspace(userId),
    listClientChoices(userId),
    listInvoices(userId, {
      status: filters.statusValue,
      clientId: filters.clientValue,
      search: filters.q || undefined,
      limit: 2000,
    }),
  ]);
  const ids = matching.map((i) => i.id);
  const [next, dues] = await Promise.all([nextMessagesByInvoice(userId, ids), openInstallmentDues(userId, ids)]);
  const today = todayIn(workspace.zone);
  const sorted = matching
    .map((inv) => computeRowData(inv, { today, zone: workspace.zone, profileComplete: workspace.profileComplete, onboardingDone: workspace.onboardingDone, next, dues }))
    .sort(compareRows);
  const hasMore = sorted.length > filters.limit;
  const rows = sorted.slice(0, filters.limit);
  const [overdue, pending] = await Promise.all([overdueByCurrency(userId, today), pendingApprovalCount(userId)]);
  const filtered = Boolean(filters.status || filters.clientId || filters.q);
  const values: InvoiceFilterValues = { status: filters.status, clientId: filters.clientId, q: filters.q, limit: filters.limit };

  return (
    <>
      <SummaryLine overdue={overdue} pending={pending} />
      <InvoiceFilters values={values} clients={clients} />
      {rows.length === 0 ? (
        <InvoicesEmpty filtered={filtered} />
      ) : (
        <>
          <InvoiceRows rows={rows} />
          <p className="text-[13px] text-ink-3">
            Showing {rows.length} invoice{rows.length === 1 ? "" : "s"}
            {hasMore ? "." : ", all of them."}
          </p>
          {hasMore ? (
            <div>
              <LinkButton href={showMoreHref(values)} variant="secondary">Show more</LinkButton>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
