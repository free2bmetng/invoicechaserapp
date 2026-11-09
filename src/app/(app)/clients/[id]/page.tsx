import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { LinkButton } from "@/components/invoices/link-button";
import { InvoiceRows, computeRowData } from "@/components/invoices/invoice-list";
import { ClientDetailsForm } from "@/components/clients/client-details-form";
import { AutoSendSwitch } from "@/components/clients/auto-send-switch";
import { ContactsEditor } from "@/components/clients/contacts-editor";
import { HoldsPanel } from "@/components/clients/holds-panel";
import { dayLabelFor, lateLabel, todayIn } from "@/components/invoices/format";
import { isUuidText } from "@/components/invoices/form-state";
import { getClientDetail, listClients, listInvoices, NotFoundError } from "@/lib/engine";
import { systemClock } from "@/lib/clock";
import {
  heldMessageCountForClient, listStandardSequenceChoices, loadWorkspace, nextMessagesByInvoice, openInstallmentDues,
} from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Client" };

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <ClientDetailSection params={params} />
    </Suspense>
  );
}

async function ClientDetailSection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidText(id)) notFound();
  const userId = await requireUserId();

  let client: Awaited<ReturnType<typeof getClientDetail>>;
  try {
    client = await getClientDetail(userId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [workspace, invoices, sequences, heldCount, clientRows] = await Promise.all([
    loadWorkspace(userId),
    listInvoices(userId, { clientId: id, limit: 500 }),
    listStandardSequenceChoices(userId),
    heldMessageCountForClient(userId, id),
    listClients(userId, systemClock),
  ]);
  const summary = clientRows.find((c) => c.id === id) ?? null;
  const typicallyPays = lateLabel(summary?.avgDaysLate ?? null);
  const issueToPayment = summary?.averageDaysToPay ?? null;
  const ids = invoices.map((i) => i.id);
  const [next, dues] = await Promise.all([nextMessagesByInvoice(userId, ids), openInstallmentDues(userId, ids)]);
  const today = todayIn(workspace.zone);
  const rows = invoices.map((inv) =>
    computeRowData(inv, { today, zone: workspace.zone, profileComplete: workspace.profileComplete, onboardingDone: workspace.onboardingDone, next, dues }),
  );

  const heldContacts = client.contacts
    .filter((ct): ct is typeof ct & { hold: "bounced" | "paused" } => ct.hold === "bounced" || ct.hold === "paused")
    .map((ct) => ({ id: ct.id, email: ct.email, hold: ct.hold }));

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-ink-3">
        <Link href="/clients" className="hover:text-ink">Clients</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{client.name}</span>
      </nav>

      <PageHeader
        title={client.name}
        description={client.email}
        actions={<LinkButton href={`/invoices/new?client=${client.id}`} variant="primary">New invoice for {client.name}</LinkButton>}
      />

      <div className="mt-8 grid gap-6">
        <section aria-labelledby="pays-heading" className="grid gap-1 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:p-6">
          <h2 id="pays-heading" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">Typically pays</h2>
          <p className="num text-[22px] font-semibold tracking-[-0.02em] text-ink">{typicallyPays ?? "—"}</p>
          <p className="text-[13px] leading-5 text-ink-3">
            The mean number of days from the due date to payment. A negative figure means the client pays early.
          </p>
          {issueToPayment !== null ? (
            <p className="text-[13px] leading-5 text-ink-2">Averages {Math.round(issueToPayment)} days from issue to payment.</p>
          ) : null}
        </section>

        <HoldsPanel
          clientId={client.id}
          repliedLabel={client.replyHeldAt ? dayLabelFor(client.replyHeldAt.toISOString(), workspace.zone) : null}
          heldContacts={heldContacts}
          heldMessageCount={heldCount}
        />

        <Section id="invoices-heading" title="Invoices" description={`${invoices.length} for this client.`}>
          {rows.length === 0 ? (
            <EmptyState
              title="No invoices for this client yet"
              body="Add an invoice for this client and its reminders are planned from the due date."
              action={<LinkButton href={`/invoices/new?client=${client.id}`} variant="primary">Add an invoice</LinkButton>}
            />
          ) : (
            <InvoiceRows rows={rows} showClient={false} />
          )}
        </Section>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Section id="details-heading" title="Details" description="Who this client is, the zone their send window uses, and the sequence for their invoices.">
            <ClientDetailsForm
              clientId={client.id}
              name={client.name}
              email={client.email}
              timezone={client.timezone}
              sequenceId={client.sequenceId}
              sequences={sequences}
              workspaceZone={workspace.zone}
            />
          </Section>

          <Section id="autosend-heading" title="Auto-send">
            <AutoSendSwitch clientId={client.id} autoSend={client.autoSend} />
          </Section>
        </div>

        <Section id="contacts-heading" title="Contacts" description="The primary contact receives reminders. Anyone else you add can be copied on invoices.">
          <ContactsEditor
            clientId={client.id}
            contacts={client.contacts.map((ct) => ({ id: ct.id, name: ct.name, email: ct.email, isPrimary: ct.isPrimary, hold: ct.hold }))}
          />
        </Section>

      </div>
    </>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 id={id} className="text-[16px] font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-1 text-[13px] leading-5 text-ink-3">{description}</p> : null}
      <div className="mt-5">{children}</div>
    </Card>
  );
}
