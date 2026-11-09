import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DateTime } from "luxon";
import { Card, cx } from "@/components/ui";
import { EditableSection, SummaryList, formatTimelineTime } from "@/components/data";
import { InvoiceStatusBadge } from "@/components/status";
import { Money } from "@/components/money";
import { BackLink } from "@/components/invoices/back-link";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { InvoiceEditForm } from "@/components/invoices/invoice-edit-form";
import { ContactsPanel } from "@/components/invoices/contacts-panel";
import { PaymentPlanPanel } from "@/components/invoices/payment-plan-panel";
import { PlanSchedule } from "@/components/invoices/plan-schedule";
import { Activity } from "@/components/invoices/activity";
import { daysBetween, dueDateLabel, minorToInput, todayIn } from "@/components/invoices/format";
import { dueWhen, paidTiming } from "@/components/invoices/status-model";
import { formatMoneyInput } from "@/components/invoices/money-input";
import { isUuidText } from "@/components/invoices/form-state";
import { CURRENCIES } from "@/components/invoices/currencies";
import { getClientDetail, getInvoiceDetail, NotFoundError, type EventView, type InvoiceDetail } from "@/lib/engine";
import { formatMoney } from "@/lib/money";
import { invoiceTitle, listStandardSequenceChoices, loadWorkspace, type SequenceChoice, type Workspace } from "@/lib/queries/invoices";
import { getUserId, requireUserId } from "@/lib/session";

// "Invoice PC-9002 · Invoice Chaser". Reads the session, so the page keeps a dynamic part in
// Suspense (the detail section below), as Cache Components asks for runtime metadata.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!isUuidText(id)) return { title: "Invoice not found" };
  const userId = await getUserId();
  if (!userId) return { title: "Invoice" };
  const found = await invoiceTitle(userId, id);
  return { title: found ? `Invoice ${found.number} · ${found.client}` : "Invoice not found" };
}

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <BackLink href="/invoices">Invoices</BackLink>
      <Suspense fallback={<DetailSkeleton />}>
        <InvoiceDetailSection params={params} />
      </Suspense>
    </>
  );
}

const CLOSED = ["paid", "written_off"];

async function InvoiceDetailSection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidText(id)) notFound();
  const userId = await requireUserId();

  let detail: InvoiceDetail;
  try {
    detail = await getInvoiceDetail(userId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [workspace, client, sequences] = await Promise.all([
    loadWorkspace(userId),
    getClientDetail(userId, detail.client.id),
    listStandardSequenceChoices(userId),
  ]);

  const inv = detail.invoice;
  const zone = workspace.zone;
  const today = todayIn(zone);
  const closed = CLOSED.includes(inv.status);
  const installments = detail.installments;
  const nextOpen = installments.find((i) => i.status === "open") ?? null;
  const anyPaidInstallment = installments.some((i) => i.status === "paid");
  const planEditable = (inv.status === "open" || inv.status === "payment_plan") && !anyPaidInstallment;
  const contactOptions = client.contacts.map((ct) => ({ id: ct.id, name: ct.name, email: ct.email, hold: ct.hold }));

  const detailsSummary = (
    <SummaryList
      items={[
        // The number, amount and due date are in the header; this adds the terms they came from.
        {
          label: "Issued",
          value: (
            <span className="num">
              {dueDateLabel(inv.issueDate)}
              <span className="text-ink-3"> · {termsText(inv.issueDate, inv.dueDate)}</span>
            </span>
          ),
        },
        { label: "Reminder sequence", value: sequenceText(inv.sequenceId, detail.client.sequenceId, sequences) },
        { label: "Notes", value: inv.notes.trim() ? <span className="whitespace-pre-line">{inv.notes}</span> : <span className="text-ink-3">None</span> },
        { label: "Added", value: sourceLabel(inv.source) },
      ]}
    />
  );

  const contactsSummary =
    contactOptions.length === 0 ? null : (
      <SummaryList
        items={[
          {
            label: "Sent to",
            value: detail.contacts.primary ? <ContactLine name={detail.contacts.primary.name} email={detail.contacts.primary.email} /> : null,
          },
          {
            label: "Copied in",
            value:
              detail.contacts.cc.length > 0 ? (
                <span className="grid gap-1">
                  {detail.contacts.cc.map((ct) => (
                    <ContactLine key={ct.id} name={ct.name} email={ct.email} />
                  ))}
                </span>
              ) : (
                <span className="text-ink-3">Nobody</span>
              ),
          },
        ]}
      />
    );

  const planSection =
    installments.length > 0 ? (
      planEditable ? (
        <EditableSection title="Payment plan" editLabel="Change plan" summary={<PlanSchedule installments={installments} currency={inv.currency} totalMinor={inv.amountMinor} today={today} zone={zone} />}>
          <PaymentPlanPanel
            invoiceId={id}
            currency={inv.currency}
            totalMinor={inv.amountMinor}
            dueDate={inv.dueDate}
            existing={installments.map((i) => ({ dueDate: i.dueDate, amountMinor: i.amountMinor, status: i.status }))}
          />
        </EditableSection>
      ) : (
        <StaticSection title="Payment plan">
          <PlanSchedule installments={installments} currency={inv.currency} totalMinor={inv.amountMinor} today={today} zone={zone} />
        </StaticSection>
      )
    ) : null;

  const offerPlan = inv.status === "open" && installments.length === 0;

  return (
    <>
      <Header detail={detail} workspace={workspace} today={today} nextOpenId={nextOpen?.id ?? null} />

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="grid min-w-0 gap-6">
          {planSection}

          {closed ? (
            <StaticSection title="Details" footnote="Reopen the invoice to edit its details.">{detailsSummary}</StaticSection>
          ) : (
            <EditableSection title="Details" description="Number, amount, dates, sequence and notes." summary={detailsSummary}>
              <InvoiceEditForm
                invoiceId={id}
                defaults={{
                  invoiceNumber: inv.invoiceNumber,
                  amount: formatMoneyInput(minorToInput(inv.amountMinor, inv.currency), inv.currency),
                  currency: inv.currency,
                  issueDate: inv.issueDate,
                  dueDate: inv.dueDate,
                  notes: inv.notes,
                  sequenceId: inv.sequenceId ?? "",
                }}
                currencies={CURRENCIES}
                sequences={sequences}
              />
            </EditableSection>
          )}

          {contactsSummary === null ? (
            <StaticSection title="Reminders go to">
              <p className="text-body text-ink-2">
                {detail.client.name} has no contacts yet.{" "}
                <Link href={`/clients/${detail.client.id}`} className="font-medium text-accent underline-offset-4 hover:underline">Add one on the client page</Link>.
              </p>
            </StaticSection>
          ) : closed ? (
            <StaticSection title="Reminders go to">{contactsSummary}</StaticSection>
          ) : (
            <EditableSection title="Reminders go to" summary={contactsSummary}>
              <ContactsPanel
                invoiceId={id}
                contacts={contactOptions}
                primaryId={detail.contacts.primary?.id ?? null}
                copiedIds={detail.contacts.cc.map((ct) => ct.id)}
              />
            </EditableSection>
          )}

          {offerPlan ? (
            <EditableSection
              title="Payment plan"
              editLabel="Set up a plan"
              summary={<p className="text-body text-ink-2">Split this invoice into dated installments. Each one gets its own reminders.</p>}
            >
              <PaymentPlanPanel invoiceId={id} currency={inv.currency} totalMinor={inv.amountMinor} dueDate={inv.dueDate} existing={[]} />
            </EditableSection>
          ) : null}
        </div>

        <div className="min-w-0 xl:sticky xl:top-6">
          <Activity
            invoiceId={id}
            status={inv.status}
            messages={detail.messages}
            events={detail.events}
            installments={installments}
            zone={zone}
            upcomingNote={upcomingNote(inv.status, workspace)}
          />
        </div>
      </div>
    </>
  );
}

function Header({ detail, workspace, today, nextOpenId }: { detail: InvoiceDetail; workspace: Workspace; today: string; nextOpenId: string | null }) {
  const inv = detail.invoice;
  const zone = workspace.zone;
  const installments = detail.installments;
  const nextOpen = installments.find((i) => i.id === nextOpenId) ?? null;
  const paidSoFar = installments.filter((i) => i.status === "paid").reduce((s, i) => s + i.amountMinor, 0);
  const primary = detail.contacts.primary;

  let dueLine: ReactNode = null;
  if (inv.status === "payment_plan" && nextOpen) {
    const when = dueWhen(nextOpen.dueDate, today);
    dueLine = (
      <>
        {paidSoFar > 0 ? (
          <>
            <Money minor={inv.amountMinor - paidSoFar} currency={inv.currency} /> left ·{" "}
          </>
        ) : null}
        Installment {nextOpen.position} of {installments.length} ·{" "}
        <span className={toneClass(when.tone)}>{when.overdueDays > 0 ? when.text : when.text.replace(/^Due/, "due")}</span>
      </>
    );
  } else if (inv.status === "open" || inv.status === "paused" || inv.status === "disputed") {
    const when = dueWhen(inv.dueDate, today);
    dueLine = (
      <>
        Due {dueDateLabel(inv.dueDate)} · <span className={toneClass(when.tone)}>{when.text === "Due today" ? "today" : when.text.replace(/^Due in/, "in").replace(/^Due tomorrow/, "tomorrow")}</span>
      </>
    );
  }

  const nextMessage = detail.messages
    .filter((m) => ["scheduled", "pending_approval"].includes(m.status))
    .sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime())[0];

  return (
    <Card as="section" className="overflow-hidden">
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-page-title text-ink">{inv.invoiceNumber}</h1>
            <InvoiceStatusBadge status={inv.status} />
          </div>
          <p className="mt-1 truncate text-body text-ink-2">
            <Link href={`/clients/${detail.client.id}`} className="font-medium text-ink underline-offset-4 hover:underline">{detail.client.name}</Link>
            {primary ? <span className="text-ink-3"> · {primary.email}</span> : null}
          </p>
        </div>
        {/* On a phone the amount comes first, then the actions; on desktop the actions sit top right. */}
        <div className="max-sm:order-3">
          <InvoiceActions
            invoiceId={inv.id}
            status={inv.status}
            nextInstallment={
              nextOpen ? { id: nextOpen.id, label: `installment ${nextOpen.position} · ${formatMoney(nextOpen.amountMinor, nextOpen.currency)}` } : null
            }
          />
        </div>

      {inv.status === "paid" ? (
        <div className="max-sm:order-2 sm:col-span-2">
          <Receipt detail={detail} zone={zone} />
        </div>
      ) : (
        <div className="grid gap-1 max-sm:order-2 sm:col-span-2">
          <Money minor={inv.amountMinor} currency={inv.currency} className="text-[32px] leading-10 font-semibold tracking-[-0.02em] text-ink" />
          {dueLine ? <p className="num text-body text-ink-2">{dueLine}</p> : null}
          {(inv.status === "open" || inv.status === "payment_plan") && nextMessage ? (
            <p className="num text-small text-ink-3">
              Next reminder {formatTimelineTime(nextMessage.plannedAt.toISOString(), zone)}
              {nextMessage.status === "pending_approval" ? (
                <>
                  {" · "}
                  <Link href="/needs-you" className="font-medium text-warn underline-offset-4 hover:underline">waits for your approval</Link>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      )}
      </div>

      <StateBanner detail={detail} zone={zone} />
    </Card>
  );
}

// Paid invoices lead with a receipt: when, how, and how late. No edit form, no stop controls.
function Receipt({ detail, zone }: { detail: InvoiceDetail; zone: string }) {
  const inv = detail.invoice;
  const method = paymentMethod(detail.events);
  const paidDate = inv.paidAt ? DateTime.fromJSDate(inv.paidAt).setZone(zone).setLocale("en").toFormat("d LLL yyyy") : null;
  return (
    <div className="grid gap-4 rounded-[var(--radius-md)] border border-ok/25 bg-ok-soft/60 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-6 sm:p-5">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-ok-fill text-white">
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="m5 10.5 3.2 3.2L15 6.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div>
          <p className="text-small font-medium text-ok">Paid in full</p>
          <Money minor={inv.amountMinor} currency={inv.currency} className="text-[28px] leading-8 font-semibold tracking-[-0.02em] text-ink" />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 sm:justify-self-end">
        <ReceiptFact label="Paid on" value={paidDate ?? "Not recorded"} />
        <ReceiptFact label="Method" value={method} />
        <ReceiptFact label="Timing" value={inv.paidAt ? paidTiming(inv.paidAt, inv.dueDate, zone) : "Not recorded"} />
      </dl>
    </div>
  );
}

function ReceiptFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="num text-body font-medium text-ink">{value}</dd>
    </div>
  );
}

// How the invoice was paid, from its events: Stripe, recorded by hand, or marked paid by hand.
function paymentMethod(events: EventView[]): string {
  const payment = events.find((e) => e.type === "payment_recorded");
  const paidChange = events.find((e) => e.type === "status_changed" && e.detail.to === "paid");
  if (payment && (!paidChange || Math.abs(payment.createdAt.getTime() - paidChange.createdAt.getTime()) < 5000)) {
    return payment.detail.source === "stripe" ? "Stripe" : "Recorded by you";
  }
  return "Marked paid by you";
}

// One line under the amount for the stopped states: since when, and why (the dispute reason).
function StateBanner({ detail, zone }: { detail: InvoiceDetail; zone: string }) {
  const inv = detail.invoice;
  if (!["disputed", "paused", "written_off"].includes(inv.status)) return null;
  const change = detail.events.find((e) => e.type === "status_changed" && e.detail.to === inv.status);
  const since = change ? DateTime.fromJSDate(change.createdAt).setZone(zone).setLocale("en").toFormat("d LLL yyyy") : null;
  if (inv.status === "disputed") {
    // The reason is the newest note written since the invoice became disputed.
    const reason = detail.events.find((e) => e.type === "invoice_note" && (!change || e.createdAt >= change.createdAt));
    const note = reason && typeof reason.detail.note === "string" ? reason.detail.note : null;
    return (
      <div className="border-t border-warn/25 bg-warn-soft/60 px-4 py-3 sm:px-6">
        <p className="text-body text-ink">
          <span className="font-medium text-warn">Disputed{since ? ` since ${since}` : ""}.</span> No reminders are sent until you resolve it.
        </p>
        {note ? (
          <p className="mt-1.5 border-l-2 border-warn/40 pl-3 text-body whitespace-pre-line text-ink-2">{note}</p>
        ) : (
          <p className="mt-1 text-small text-ink-2">
            No reason recorded yet.{" "}
            <a href="#invoice-note" className="font-medium text-accent underline-offset-4 hover:underline">Add a note</a> so you remember what was disputed.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="border-t border-line bg-surface-2/70 px-4 py-3 sm:px-6">
      <p className="text-body text-ink-2">
        {inv.status === "paused"
          ? `Paused${since ? ` since ${since}` : ""}. Nothing is sent until you resume reminders.`
          : `Written off${since ? ` on ${since}` : ""}. Nothing more is sent.`}
      </p>
    </div>
  );
}

function StaticSection({ title, footnote, children }: { title: string; footnote?: string; children: ReactNode }) {
  return (
    <Card as="section" className="px-4 py-4 sm:px-6 sm:py-5">
      <h2 className="text-card-title text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
      {footnote ? <p className="mt-4 text-small text-ink-3">{footnote}</p> : null}
    </Card>
  );
}

function ContactLine({ name, email }: { name: string; email: string }) {
  return name ? (
    <span className="block min-w-0">
      <span className="text-ink">{name}</span> <span className="break-all text-ink-3">{email}</span>
    </span>
  ) : (
    <span className="break-all">{email}</span>
  );
}

function toneClass(tone: string): string {
  return cx(tone === "danger" && "font-medium text-danger", tone === "warn" && "font-medium text-warn");
}

function sequenceText(invoiceSeq: string | null, clientSeq: string | null, sequences: SequenceChoice[]): string {
  const name = (id: string | null) => sequences.find((s) => s.id === id)?.name ?? null;
  if (invoiceSeq && name(invoiceSeq)) return `${name(invoiceSeq)} (chosen for this invoice)`;
  if (clientSeq && name(clientSeq)) return `${name(clientSeq)} (the client's sequence)`;
  const fallback = sequences.find((s) => s.isDefault)?.name;
  return fallback ? `${fallback} (the default)` : "The default sequence";
}

function termsText(issue: string, due: string): string {
  const days = daysBetween(issue, due);
  return days === 0 ? "due on issue" : `${days}-day terms`;
}

function sourceLabel(source: string): string {
  if (source === "csv") return "Imported from a CSV file";
  if (source === "stripe") return "Synced from Stripe";
  return "Added by hand";
}

function upcomingNote(status: string, workspace: Workspace): ReactNode {
  if (status === "paid") return "Paid, so no more reminders are sent.";
  if (status === "written_off") return "Written off, so nothing more is sent.";
  if (status === "paused") return "Paused. Nothing is sent until you resume reminders.";
  if (status === "disputed") return "Nothing is sent while the invoice is disputed.";
  if (!workspace.onboardingDone) return "Reminders are planned once setup is finished.";
  if (!workspace.profileComplete) {
    return (
      <>
        Reminders wait until your sender profile is complete in{" "}
        <Link href="/settings" className="font-medium text-accent underline-offset-4 hover:underline">Settings</Link>.
      </>
    );
  }
  return "No reminders left in the sequence.";
}
