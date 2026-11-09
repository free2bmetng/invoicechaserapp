import { Suspense } from "react";
import type { Metadata } from "next";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { LinkButton } from "@/components/invoices/link-button";
import { AddClientForm } from "@/components/clients/add-client-form";
import { ClientRows, sortByOverdue } from "@/components/clients/client-list";
import { listClients } from "@/lib/engine";
import { loadWorkspace } from "@/lib/queries/invoices";
import { systemClock } from "@/lib/clock";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Clients" };

export default function ClientsPage() {
  return (
    <>
      <PageHeader
        title="Clients"
        description="Who has overdue invoices, how quickly each client pays, and when you last contacted them."
        actions={<LinkButton href="/invoices/new" variant="secondary">New invoice</LinkButton>}
      />
      <div className="mt-8 grid gap-6">
        <Suspense fallback={<ListSkeleton />}>
          <ClientsSection />
        </Suspense>
      </div>
    </>
  );
}

// Reads the session and the data, so it sits behind the Suspense boundary above.
async function ClientsSection() {
  const userId = await requireUserId();
  const [clients, workspace] = await Promise.all([listClients(userId, systemClock), loadWorkspace(userId)]);
  return (
    <>
      <Card as="section" className="p-5 sm:p-6">
        <details open={clients.length === 0} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-ink marker:hidden [&::-webkit-details-marker]:hidden">
            Add a client
            <span aria-hidden="true" className="text-[13px] font-medium text-accent group-open:hidden">Show</span>
            <span aria-hidden="true" className="hidden text-[13px] font-medium text-ink-3 group-open:inline">Hide</span>
          </summary>
          <div className="mt-5">
            <AddClientForm />
          </div>
        </details>
      </Card>

      {clients.length === 0 ? (
        <EmptyState
          title="No clients yet"
          body="Clients appear when you add an invoice or import a CSV. You can also add one above, then add its invoices."
          action={<LinkButton href="/invoices/import" variant="secondary">Import a CSV</LinkButton>}
        />
      ) : (
        <ClientRows clients={sortByOverdue(clients)} zone={workspace.zone} />
      )}
    </>
  );
}
