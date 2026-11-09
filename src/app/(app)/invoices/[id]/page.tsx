import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { InvoiceStatusBadge } from "@/components/status";
import { Money } from "@/components/money";
import { LinkButton } from "@/components/invoices/link-button";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { StatusPanel } from "@/components/invoices/status-panel";
import { InvoiceEditForm } from "@/components/invoices/invoice-edit-form";
import { ContactsPanel } from "@/components/invoices/contacts-panel";
import { PaymentPlanPanel } from "@/components/invoices/payment-plan-panel";
import { Timeline } from "@/components/invoices/timeline";
import { minorToInput, dueDateLabel, daysBetween, describeNextMessage, isOverdue, OUTSTANDING_STATUSES, pluralDays, todayIn } from "@/components/invoices/format";
import { isUuidText } from "@/components/invoices/form-state";
import { CURRENCIES } from "@/components/invoices/currencies";
import { getClientDetail, getInvoiceDetail, NotFoundError } from "@/lib/engine";
import { listStandardSequenceChoices, loadWorkspace, nextMessagesByInvoice } from "@/lib/queries/invoices";
import type { InvoiceStatus } from "@/lib/types";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Invoice" };

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <InvoiceDetailSection params={params} />
    </Suspense>
  );
}

const LOCKED_STATUSES: readonly InvoiceStatus[] = ["paid", "written_off"];

async function InvoiceDetailSection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidText(id)) notFound();
  const userId = await requireUserId();

  let detail: Awaited<ReturnType<typeof getInvoiceDetail>>;
  try {
    detail = await getInvoiceDetail(userId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [workspace, client, sequences, next] = await Promise.all([
    loadWorkspace(userId),
    getClientDetail(userId, detail.client.id),
    listStandardSequenceChoices(userId),
    nextMessagesByInvoice(userId, [id]),
  ]);

  const inv = detail.invoice;
  const zone = detail.client.timezone && detail.client.timezone !== "" ? detail.client.timezone : workspace.zone;
  const today = todayIn(workspace.zone);
  const locked = LOCKED_STATUSES.includes(inv.status);
  const outstanding = (OUTSTANDING_STATUSES as readonly string[]).includes(inv.status);
  const checkDue = inv.hasPaymentPlan
    ? (detail.installments.find((i) => i.status === "open")?.dueDate ?? inv.dueDate)
    : inv.dueDate;
  const overdueDays = outstanding && isOverdue(checkDue, today) ? daysBetween(checkDue, today) : 0;
  const nextRow = next.get(id) ?? null;
  const nextText = describeNextMessage({
    invoiceStatus: inv.status,
    next: nextRow,
    zone: nextRow?.clientTimezone ?? zone,
    profileComplete: workspace.profileComplete,
    onboardingDone: workspace.onboardingDone,
  });

  const lockedReason = locked
    ? `This invoice is ${inv.status === "paid" ? "paid" : "written off"}, so its details cannot be edited. Set its status to open to make changes.`
    : null;

  const paymentPlanLock = planLockReason(inv.status, detail.installments.some((i) => i.status === "paid"));
  const contactOptions = client.contacts.map((ct) => ({ id: ct.id, name: ct.name, email: ct.email, hold: ct.hold }));
  const copiedIds = detail.contacts.cc.map((ct) => ct.id);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-ink-3">
        <Link href="/invoices" className="hover:text-ink">Invoices</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{inv.invoiceNumber}</span>
      </nav>

      <PageHeader
        title={inv.invoiceNumber}
        description={`For ${inv.clientName}`}
        actions={
          <>
            <LinkButton href={`/clients/${detail.client.id}`} variant="ghost">View client</LinkButton>
          </>
        }
      />

      <Card className="mt-8 grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[28px] font-semibold tracking-[-0.02em] text-ink"><Money minor={inv.amountMinor} currency={inv.currency} /></p>
            <InvoiceStatusBadge status={inv.status} />
          </div>
          <p className={overdueDays > 0 ? "num text-[14px] font-medium text-warn" : "num text-[14px] text-ink-2"}>
            {inv.hasPaymentPlan ? `Next installment due ${dueDateLabel(checkDue)}` : `Due ${dueDateLabel(inv.dueDate)}`}
            {overdueDays > 0 ? ` · ${pluralDays(overdueDays)} overdue` : ""}
          </p>
          <p className="text-[14px] leading-6 text-ink-2">{nextText}</p>
        </div>
        <dl className="grid gap-1 text-[13px] text-ink-2 sm:text-right">
          <div><dt className="inline text-ink-3">Issued </dt><dd className="num inline">{dueDateLabel(inv.issueDate)}</dd></div>
          <div><dt className="inline text-ink-3">Sent to </dt><dd className="inline">{detail.contacts.primary?.email ?? "No contact"}</dd></div>
          <div><dt className="inline text-ink-3">Source </dt><dd className="inline">{sourceLabel(inv.source)}</dd></div>
        </dl>
      </Card>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        <Section id="status-heading" title="Status">
          <StatusPanel invoiceId={id} status={inv.status} />
        </Section>

        <Section id="contacts-heading" title="Contacts" description="Who gets the reminders for this invoice.">
          <ContactsPanel
            invoiceId={id}
            contacts={contactOptions}
            primaryId={detail.contacts.primary?.id ?? null}
            copiedIds={copiedIds}
            locked={locked}
          />
        </Section>

        <Section id="details-heading" title="Details" description="Edit the invoice. Changing the due date or sequence re-plans its reminders.">
          <InvoiceEditForm
            invoiceId={id}
            defaults={{
              invoiceNumber: inv.invoiceNumber,
              amount: minorToInput(inv.amountMinor, inv.currency),
              currency: inv.currency,
              issueDate: inv.issueDate,
              dueDate: inv.dueDate,
              notes: inv.notes,
              sequenceId: inv.sequenceId ?? "",
            }}
            currencies={CURRENCIES}
            sequences={sequences}
            locked={locked}
            lockedReason={lockedReason}
          />
        </Section>

        <Section id="plan-heading" title="Payment plan" description={`Split ${formatMoney(inv.amountMinor, inv.currency)} into dated installments that add up to exactly that. Each one gets its own reminders.`}>
          <PaymentPlanPanel
            invoiceId={id}
            currency={inv.currency}
            totalMinor={inv.amountMinor}
            dueDate={inv.dueDate}
            existing={detail.installments.map((i) => ({ dueDate: i.dueDate, amountMinor: i.amountMinor, status: i.status }))}
            lockedReason={paymentPlanLock}
          />
        </Section>
      </div>

      <Section id="timeline-heading" title="Timeline" description="Every reminder for this invoice, and what happened to it." className="mt-8">
        <Timeline messages={detail.messages} events={detail.events} zone={zone} />
      </Section>
    </>
  );
}

function planLockReason(status: InvoiceStatus, anyPaid: boolean): string | null {
  if (status === "paid" || status === "written_off") {
    return "This invoice is closed, so its payment plan cannot change. Set its status to open to make changes.";
  }
  if (status !== "open" && status !== "payment_plan") {
    return "Payment plans can start only on open invoices. Set this invoice to open first.";
  }
  if (anyPaid) return "An installment has been paid, so this plan cannot be replaced.";
  return null;
}

function sourceLabel(source: string): string {
  if (source === "csv") return "Imported from a CSV file";
  if (source === "stripe") return "From Stripe";
  return "Added by hand";
}

function Section({
  id,
  title,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="section" className={`p-5 sm:p-6 ${className ?? ""}`}>
      <h2 id={id} className="text-[16px] font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-1 text-[13px] leading-5 text-ink-3">{description}</p> : null}
      <div className="mt-5">{children}</div>
    </Card>
  );
}
