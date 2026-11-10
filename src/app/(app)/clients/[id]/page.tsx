import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { EditableSection, StatTile, SummaryList } from "@/components/data";
import { Money, MoneyList } from "@/components/money";
import { BackLink } from "@/components/invoices/back-link";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { LinkButton } from "@/components/invoices/link-button";
import { InvoiceRows, computeRowData } from "@/components/invoices/invoice-list";
import { AutoSendSwitch } from "@/components/clients/auto-send-switch";
import { ClientDetailsForm } from "@/components/clients/client-details-form";
import { ContactList } from "@/components/clients/contact-list";
import { HoldsPanel } from "@/components/clients/holds-panel";
import { dayLabelFor, lateLabel, todayIn } from "@/components/invoices/format";
import { isUuidText } from "@/components/invoices/form-state";
import { getClientDetail, listInvoices, NotFoundError, type MoneyTotal } from "@/lib/engine";
import { systemClock } from "@/lib/clock";
import {
  heldMessageCountForClient, listStandardSequenceChoices, loadWorkspace, nextMessagesByInvoice, openInstallmentDues,
} from "@/lib/queries/invoices";
import { getUserId, requireUserId } from "@/lib/session";
import { clientName, loadClientFigures } from "../client-data";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!isUuidText(id)) return { title: "Client not found" };
  const userId = await getUserId();
  if (!userId) return { title: "Client" };
  const name = await clientName(userId, id);
  return { title: name ?? "Client not found" };
}

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <BackLink href="/clients">Clients</BackLink>
      <Suspense fallback={<DetailSkeleton />}>
        <ClientDetailSection params={params} />
      </Suspense>
    </>
  );
}

const OPEN = ["open", "payment_plan", "paused", "disputed"];

// The largest currency line as the headline; any others go underneath.
function Headline({ totals }: { totals: MoneyTotal[] }) {
  const [first] = totals;
  return first ? <Money minor={first.amountMinor} currency={first.currency} /> : null;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <span className="text-[17px] font-medium tracking-normal text-ink-3">{children}</span>;
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

  const [workspace, invoices, sequences, heldCount, figures] = await Promise.all([
    loadWorkspace(userId),
    listInvoices(userId, { clientId: id, limit: 500 }),
    listStandardSequenceChoices(userId),
    heldMessageCountForClient(userId, id),
    loadClientFigures(userId, id, systemClock),
  ]);
  const ids = invoices.map((i) => i.id);
  const [next, dues] = await Promise.all([nextMessagesByInvoice(userId, ids), openInstallmentDues(userId, ids)]);
  const today = todayIn(workspace.zone);
  const rows = invoices.map((inv) =>
    computeRowData(inv, { today, zone: workspace.zone, profileComplete: workspace.profileComplete, onboardingDone: workspace.onboardingDone, next, dues }),
  );

  const outstanding = [...(figures?.outstanding ?? [])].sort((a, b) => b.amountMinor - a.amountMinor);
  const overdue = [...(figures?.overdue ?? [])].sort((a, b) => b.amountMinor - a.amountMinor);
  const openCount = invoices.filter((i) => OPEN.includes(i.status)).length;
  const overdueRows = rows.filter((r) => r.overdueDays > 0 && (r.invoice.status === "open" || r.invoice.status === "payment_plan"));
  const oldest = overdueRows.reduce((max, r) => Math.max(max, r.overdueDays), 0);
  const pays = lateLabel(figures?.avgDaysLate ?? null);
  const slow = figures?.avgDaysLate !== null && figures?.avgDaysLate !== undefined && figures.avgDaysLate > 14;
  const lastReply = figures?.lastReplyAt ? dayLabelFor(figures.lastReplyAt.toISOString(), workspace.zone) : null;
  const lastContact = figures?.lastContactAt ? dayLabelFor(figures.lastContactAt.toISOString(), workspace.zone) : null;

  const primary = client.contacts.find((ct) => ct.isPrimary) ?? null;
  const emailDiffers = !primary || primary.email !== client.email;
  const sequence = sequences.find((s) => s.id === client.sequenceId) ?? null;
  const defaultSequence = sequences.find((s) => s.isDefault) ?? null;
  const shownSequence = sequence ?? defaultSequence;

  const heldContacts = client.contacts
    .filter((ct): ct is typeof ct & { hold: "bounced" | "paused" } => ct.hold === "bounced" || ct.hold === "paused")
    .map((ct) => ({ id: ct.id, email: ct.email, hold: ct.hold }));

  return (
    <>
      <PageHeader
        title={client.name}
        description={client.email}
        actions={<LinkButton href={`/invoices/new?client=${client.id}`} variant="primary">New invoice</LinkButton>}
      />

      <div className="mt-6 grid gap-6">
        <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <StatTile
            label="Outstanding"
            value={outstanding.length > 0 ? <Headline totals={outstanding} /> : <Quiet>Nothing owed</Quiet>}
            sub={outstanding.length > 1
              ? <MoneyList amounts={outstanding.slice(1)} className="justify-start" />
              : `${openCount} open ${openCount === 1 ? "invoice" : "invoices"}`}
          />
          <StatTile
            label="Overdue"
            tone={overdue.length > 0 ? "danger" : "neutral"}
            value={overdue.length > 0 ? <Headline totals={overdue} /> : <Quiet>Nothing overdue</Quiet>}
            sub={overdue.length > 1
              ? <MoneyList amounts={overdue.slice(1)} className="justify-start" />
              : overdueRows.length > 0
                ? `${overdueRows.length} ${overdueRows.length === 1 ? "invoice" : "invoices"}, oldest ${oldest} ${oldest === 1 ? "day" : "days"}`
                : "All invoices on time"}
          />
          <StatTile
            label="Typically pays"
            tone={pays ? (slow ? "warn" : "neutral") : "neutral"}
            value={pays ?? <Quiet>No history yet</Quiet>}
            sub={figures?.averageDaysToPay != null
              ? `${Math.round(figures.averageDaysToPay)} days from issue, on average`
              : "Shown after the first paid invoice"}
          />
          <StatTile
            label="Last reply"
            value={lastReply ?? <Quiet>No replies</Quiet>}
            sub={lastContact ? `Last reminder ${lastContact}` : "No reminders sent yet"}
          />
        </section>

        <HoldsPanel
          clientId={client.id}
          repliedLabel={client.replyHeldAt ? dayLabelFor(client.replyHeldAt.toISOString(), workspace.zone) : null}
          heldContacts={heldContacts}
          heldMessageCount={heldCount}
        />

        <section aria-labelledby="invoices-heading" className="grid gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="invoices-heading" className="text-section-title text-ink">
              Invoices <span className="num ml-1 text-body font-normal text-ink-3">{invoices.length}</span>
            </h2>
          </div>
          {rows.length === 0 ? (
            <div className="grid justify-items-start gap-3 rounded-[var(--radius-lg)] border border-dashed border-line-strong p-5 sm:p-6">
              <p className="text-body text-ink-2">No invoices for {client.name} yet. Add one and its reminders are planned from the due date.</p>
              <LinkButton href={`/invoices/new?client=${client.id}`} variant="secondary" size="sm">Add an invoice</LinkButton>
            </div>
          ) : (
            <InvoiceRows rows={rows} showClient={false} />
          )}
        </section>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <ContactList
            clientId={client.id}
            contacts={client.contacts.map((ct) => ({ id: ct.id, name: ct.name, email: ct.email, isPrimary: ct.isPrimary, hold: ct.hold }))}
          />
          <div className="grid gap-6">
            <EditableSection
              title="Details"
              summary={
                <SummaryList
                  items={[
                    ...(emailDiffers ? [{ label: "Billing email", value: client.email }] : []),
                    {
                      label: "Sequence",
                      value: shownSequence ? (
                        <span>
                          <Link href={`/sequences/${shownSequence.id}`} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                            {shownSequence.name}
                          </Link>
                          {sequence ? null : <span className="text-ink-3"> · the default</span>}
                        </span>
                      ) : null,
                    },
                    {
                      label: "Timezone",
                      value: client.timezone ?? <span>{workspace.zone} <span className="text-ink-3">· same as yours</span></span>,
                    },
                  ]}
                />
              }
            >
              <ClientDetailsForm
                clientId={client.id}
                name={client.name}
                email={client.email}
                showEmail={emailDiffers}
                timezone={client.timezone}
                sequenceId={client.sequenceId}
                sequences={sequences}
                workspaceZone={workspace.zone}
              />
            </EditableSection>
            <AutoSendSwitch clientId={client.id} autoSend={client.autoSend} />
          </div>
        </div>
      </div>
    </>
  );
}
