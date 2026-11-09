// Presentational pieces of the invoices list. Server-rendered: the filters are a plain GET form,
// so they work without JavaScript, and each row is one link.
import Link from "next/link";
import { EmptyState, cx } from "@/components/ui";
import { InvoiceStatusBadge } from "@/components/status";
import { Money } from "@/components/money";
import type { InvoiceListItem } from "@/lib/engine";
import { describeNextMessage, dueDateLabel, daysBetween, isOverdue, OUTSTANDING_STATUSES, pluralDays, type NextMessageView } from "./format";
import { LinkButton } from "./link-button";

export interface InvoiceFilterValues {
  status: string;
  clientId: string;
  q: string;
  limit: number;
}

export interface InvoiceRowData {
  invoice: InvoiceListItem;
  dueLabel: string;
  // The date that decides overdue: the invoice due date, or the next open installment for a plan.
  checkDue: string;
  overdueDays: number;
  nextText: string;
}

const CLOSED: readonly string[] = ["paid", "written_off"];

// Overdue first (most overdue first), then open and other live invoices by due date, then closed ones.
export function compareRows(a: InvoiceRowData, b: InvoiceRowData): number {
  const groupOf = (r: InvoiceRowData) => (r.overdueDays > 0 ? 0 : CLOSED.includes(r.invoice.status) ? 2 : 1);
  const groupA = groupOf(a);
  const groupB = groupOf(b);
  if (groupA !== groupB) return groupA - groupB;
  if (a.checkDue !== b.checkDue) return a.checkDue < b.checkDue ? -1 : 1;
  return a.invoice.invoiceNumber.localeCompare(b.invoice.invoiceNumber, "en", { numeric: true });
}

// The line above the list: money overdue per currency, and reminders waiting for approval.
export function SummaryLine({ overdue, pending }: { overdue: { currency: string; amountMinor: number }[]; pending: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-3 text-[14px] shadow-card sm:px-5">
      {overdue.length === 0 ? (
        <p className="text-ink-2">Nothing is overdue.</p>
      ) : (
        <p className="text-ink-2">
          <span className="font-medium text-warn">Overdue</span>{" "}
          {overdue.map((t, i) => (
            <span key={t.currency}>
              {i > 0 ? " · " : ""}
              <Money minor={t.amountMinor} currency={t.currency} className="font-medium text-ink" />
            </span>
          ))}
        </p>
      )}
      {pending > 0 ? (
        <Link href="/needs-you" className="font-medium text-accent underline underline-offset-4">
          {pending} {pending === 1 ? "reminder is" : "reminders are"} waiting for your approval
        </Link>
      ) : null}
    </div>
  );
}

export function InvoiceRows({ rows, showClient = true }: { rows: InvoiceRowData[]; showClient?: boolean }) {
  return (
    <ul aria-label="Invoices" className="grid gap-3">
      {rows.map(({ invoice: inv, dueLabel, overdueDays, nextText }) => (
        <li key={inv.id}>
          <Link
            href={`/invoices/${inv.id}`}
            className="grid gap-3 rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-4 shadow-card transition-colors duration-150 hover:border-line-strong hover:bg-surface-2/50 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)] sm:items-center sm:gap-6 sm:px-5"
          >
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-ink">{inv.invoiceNumber}</p>
              {showClient ? <p className="truncate text-[14px] text-ink-2">{inv.clientName}</p> : null}
            </div>
            <div className="grid gap-0.5 text-[13px] sm:text-right">
              <p className="text-[15px] font-medium text-ink"><Money minor={inv.amountMinor} currency={inv.currency} /></p>
              <p className={cx("num", overdueDays > 0 ? "font-medium text-warn" : "text-ink-2")}>
                {dueLabel}
                {overdueDays > 0 ? ` · ${pluralDays(overdueDays)} overdue` : ""}
              </p>
            </div>
            <div className="grid gap-1.5 sm:justify-items-end">
              <div><InvoiceStatusBadge status={inv.status} /></div>
              <p className="text-[13px] leading-5 text-ink-2 sm:text-right">{nextText}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function computeRowData(
  inv: InvoiceListItem,
  ctx: {
    today: string;
    zone: string;
    profileComplete: boolean;
    onboardingDone: boolean;
    next: Map<string, NextMessageView & { clientTimezone: string | null }>;
    dues: Map<string, string>;
  },
): InvoiceRowData {
  const checkDue = inv.hasPaymentPlan ? (ctx.dues.get(inv.id) ?? inv.dueDate) : inv.dueDate;
  const outstanding = (OUTSTANDING_STATUSES as readonly string[]).includes(inv.status);
  const overdueDays = outstanding && isOverdue(checkDue, ctx.today) ? daysBetween(checkDue, ctx.today) : 0;
  const dueLabel = inv.hasPaymentPlan ? `Next installment ${dueDateLabel(checkDue)}` : `Due ${dueDateLabel(inv.dueDate)}`;
  const nextRow = ctx.next.get(inv.id) ?? null;
  const nextText = describeNextMessage({
    invoiceStatus: inv.status,
    next: nextRow,
    zone: nextRow?.clientTimezone ?? ctx.zone,
    profileComplete: ctx.profileComplete,
    onboardingDone: ctx.onboardingDone,
  });
  return { invoice: inv, dueLabel, checkDue, overdueDays, nextText };
}

export function showMoreHref(values: InvoiceFilterValues): string {
  const params = new URLSearchParams();
  if (values.status) params.set("status", values.status);
  if (values.clientId) params.set("client", values.clientId);
  if (values.q) params.set("q", values.q);
  params.set("limit", String(values.limit + 50));
  return `/invoices?${params.toString()}`;
}

export function InvoicesEmpty({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <EmptyState
        title="No invoices match these filters"
        body="Try another status, client or search term, or clear the filters to see everything."
        action={<LinkButton href="/invoices" variant="secondary">Clear filters</LinkButton>}
      />
    );
  }
  return (
    <EmptyState
      title="No invoices yet"
      body="Add an invoice by hand, or import a spreadsheet of them. Reminders are planned as soon as an invoice is added."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <LinkButton href="/invoices/new" variant="primary">Add an invoice</LinkButton>
          <LinkButton href="/invoices/import" variant="secondary">Import a CSV</LinkButton>
        </div>
      }
    />
  );
}

