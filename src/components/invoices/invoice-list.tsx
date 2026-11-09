// The invoices table and its summary. Server-rendered: tabs, sorting and filters are links and a
// plain GET form, so they work without JavaScript, and each row is one link.
import { DateTime } from "luxon";
import { EmptyState, Card, cx } from "@/components/ui";
import { InvoiceStatusBadge } from "@/components/status";
import { Money } from "@/components/money";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/data";
import type { InvoiceListItem } from "@/lib/engine";
import type { PlanProgress } from "@/lib/queries/invoices";
import { describeNextMessage, dueDateLabel, isOverdue, OUTSTANDING_STATUSES, type NextMessageView } from "./format";
import { dueWhen, shortDate, type PhraseTone } from "./status-model";
import { LinkButton } from "./link-button";

export interface InvoiceFilterValues {
  status: string;
  clientId: string;
  q: string;
  limit: number;
  sort?: string;
  dir?: string;
}

export interface InvoiceRowData {
  invoice: InvoiceListItem;
  dueLabel: string;
  // The date that decides overdue: the invoice due date, or the next open installment for a plan.
  checkDue: string;
  overdueDays: number;
  // The long sentence (detail page and older callers).
  nextText: string;
  // The relative due phrase for the table ("Due today", "21 days overdue"), or null when the status says it all.
  when: { text: string; tone: PhraseTone } | null;
  // What is still owed: the open installments of a plan, 0 when paid, null when written off.
  remainingMinor: number | null;
  // The compact next-reminder cell, or null when there is nothing to say.
  next: { text: string; tone: PhraseTone } | null;
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

export const SORT_KEYS = ["number", "client", "due", "amount", "remaining"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export function sortRows(rows: InvoiceRowData[], key: SortKey | null, dir: "asc" | "desc"): InvoiceRowData[] {
  if (!key) return [...rows].sort(compareRows);
  const sign = dir === "asc" ? 1 : -1;
  const byNumber = (a: InvoiceRowData, b: InvoiceRowData) =>
    a.invoice.invoiceNumber.localeCompare(b.invoice.invoiceNumber, "en", { numeric: true });
  const cmp: Record<SortKey, (a: InvoiceRowData, b: InvoiceRowData) => number> = {
    number: byNumber,
    client: (a, b) => a.invoice.clientName.localeCompare(b.invoice.clientName, "en", { sensitivity: "base" }),
    due: (a, b) => (a.checkDue === b.checkDue ? 0 : a.checkDue < b.checkDue ? -1 : 1),
    // Amounts in different currencies are not comparable; group by currency, then by amount.
    amount: (a, b) => a.invoice.currency.localeCompare(b.invoice.currency) || a.invoice.amountMinor - b.invoice.amountMinor,
    remaining: (a, b) => a.invoice.currency.localeCompare(b.invoice.currency) || (a.remainingMinor ?? -1) - (b.remainingMinor ?? -1),
  };
  return [...rows].sort((a, b) => sign * cmp[key](a, b) || byNumber(a, b));
}

function shortInstant(iso: string, zone: string): string {
  return DateTime.fromISO(iso).setZone(zone).setLocale("en").toFormat("d LLL, h:mm a");
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
    plans?: Map<string, PlanProgress>;
  },
): InvoiceRowData {
  const plan = ctx.plans?.get(inv.id);
  const planDue = plan?.nextDue ?? ctx.dues.get(inv.id) ?? null;
  const checkDue = inv.hasPaymentPlan ? (planDue ?? inv.dueDate) : inv.dueDate;
  const outstanding = (OUTSTANDING_STATUSES as readonly string[]).includes(inv.status);
  const overdue = outstanding && isOverdue(checkDue, ctx.today);
  const relative = dueWhen(checkDue, ctx.today);
  const overdueDays = overdue ? relative.overdueDays : 0;
  const dueLabel = inv.hasPaymentPlan ? `Next installment ${dueDateLabel(checkDue)}` : `Due ${dueDateLabel(inv.dueDate)}`;

  let when: InvoiceRowData["when"] = null;
  if (inv.status === "paid") {
    when = { text: inv.paidAt ? `Paid ${shortDate(DateTime.fromJSDate(inv.paidAt).setZone(ctx.zone).toISODate() ?? ctx.today, ctx.today)}` : "Paid", tone: "muted" };
  } else if (inv.status === "payment_plan" && planDue) {
    const r = dueWhen(planDue, ctx.today);
    const text =
      r.overdueDays > 0 ? `Installment ${r.text}` : r.text === "Due today" ? "Installment due today" : `Installment ${r.text.replace(/^Due /, "due ")}`;
    when = { text, tone: r.tone };
  } else if (outstanding) {
    when = { text: relative.text, tone: relative.tone };
  }

  let remainingMinor: number | null = inv.amountMinor;
  if (inv.status === "paid") remainingMinor = 0;
  else if (inv.status === "written_off") remainingMinor = null;
  else if (inv.hasPaymentPlan && plan) remainingMinor = plan.openMinor;

  const nextRow = ctx.next.get(inv.id) ?? null;
  const zone = nextRow?.clientTimezone ?? ctx.zone;
  const nextText = describeNextMessage({
    invoiceStatus: inv.status,
    next: nextRow,
    zone,
    profileComplete: ctx.profileComplete,
    onboardingDone: ctx.onboardingDone,
  });

  let next: InvoiceRowData["next"] = null;
  if (inv.status === "open" || inv.status === "payment_plan") {
    if (!ctx.onboardingDone) next = { text: "Waiting for setup", tone: "muted" };
    else if (!ctx.profileComplete) next = { text: "Waiting for your profile", tone: "muted" };
    else if (!nextRow) next = { text: "None left", tone: "muted" };
    else if (nextRow.status === "pending_approval") next = { text: `Needs approval · ${shortInstant(nextRow.plannedAt, zone)}`, tone: "warn" };
    else if (nextRow.status === "held") next = { text: "On hold", tone: "muted" };
    else next = { text: shortInstant(nextRow.plannedAt, zone), tone: "neutral" };
  }

  return { invoice: inv, dueLabel, checkDue, overdueDays, nextText, when, remainingMinor, next };
}

const phraseTone: Record<PhraseTone, string> = {
  danger: "font-medium text-danger",
  warn: "font-medium text-warn",
  muted: "text-ink-3",
  neutral: "text-ink-2",
  ok: "text-ok",
};

export function Phrase({ value, className }: { value: { text: string; tone: PhraseTone } | null; className?: string }) {
  if (!value) return null;
  return <span className={cx(phraseTone[value.tone], className)}>{value.text}</span>;
}

export interface SortState {
  key: SortKey | null;
  dir: "asc" | "desc";
  hrefFor: (key: SortKey) => string;
}

// The invoices table. On a phone each row is two lines: client and amount, then number, due phrase,
// status and next reminder. `showClient` is off on the client page, where the client is the page.
export function InvoiceTable({ rows, showClient = true, sort }: { rows: InvoiceRowData[]; showClient?: boolean; sort?: SortState }) {
  const th = (key: SortKey) =>
    sort ? { sortHref: sort.hrefFor(key), sorted: sort.key === key ? sort.dir : undefined } : {};
  return (
    <Card className="overflow-hidden">
      <Table label="Invoices">
        <THead>
          <Th {...th("number")}>Invoice</Th>
          {showClient ? <Th {...th("client")}>Client</Th> : null}
          <Th {...th("due")}>Due</Th>
          <Th align="right" {...th("amount")}>Amount</Th>
          <Th align="right" {...th("remaining")}>Remaining</Th>
          <Th>Status</Th>
          <Th>Next reminder</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const inv = row.invoice;
            const partial = row.remainingMinor !== null && row.remainingMinor !== inv.amountMinor && row.remainingMinor !== 0;
            return (
              <Tr key={inv.id} href={`/invoices/${inv.id}`} tone={row.overdueDays > 0 && (inv.status === "open" || inv.status === "payment_plan") ? "danger" : undefined}>
                <Td primary={!showClient}>
                  <span className="whitespace-nowrap">{inv.invoiceNumber}</span>
                </Td>
                {showClient ? (
                  <Td primary>
                    <span className="block truncate sm:max-w-[13rem] sm:text-ink">{inv.clientName}</span>
                  </Td>
                ) : null}
                <Td>
                  <span className="whitespace-nowrap">
                    <span className="num text-ink-2 max-sm:hidden">{dueDateLabel(row.checkDue)}</span>
                    {row.when ? <span aria-hidden="true" className="text-ink-3 max-sm:hidden"> · </span> : null}
                    <Phrase value={row.when} className="max-sm:text-small" />
                  </span>
                </Td>
                <Td numeric primary>
                  <Money minor={inv.amountMinor} currency={inv.currency} className="text-ink sm:font-medium" />
                </Td>
                <Td numeric>
                  {row.remainingMinor === null ? (
                    <span className="text-ink-3 max-sm:hidden">Written off</span>
                  ) : (
                    <>
                      <span className={cx("max-sm:hidden", row.remainingMinor === 0 && "text-ink-3")}>
                        <Money minor={row.remainingMinor} currency={inv.currency} />
                      </span>
                      {partial ? (
                        <span className="sm:hidden">
                          <Money minor={row.remainingMinor} currency={inv.currency} /> left
                        </span>
                      ) : null}
                    </>
                  )}
                </Td>
                <Td>
                  {/* On a phone the due phrase already says an invoice is open; other statuses keep their pill. */}
                  <span className={inv.status === "open" ? "max-sm:hidden" : undefined}>
                    <InvoiceStatusBadge status={inv.status} />
                  </span>
                </Td>
                <Td>
                  {row.next ? (
                    <>
                      <Phrase value={row.next} className="num text-small whitespace-nowrap max-sm:hidden" />
                      {row.next.tone === "warn" ? <span className="text-small font-medium text-warn sm:hidden">Needs approval</span> : null}
                    </>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

// Kept for the client page: the same table, with or without the client column.
export function InvoiceRows({ rows, showClient = true }: { rows: InvoiceRowData[]; showClient?: boolean }) {
  return <InvoiceTable rows={rows} showClient={showClient} />;
}

export function listHref(values: Partial<InvoiceFilterValues> & { cur?: string }, patch: Record<string, string | number | null> = {}): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | number | null | undefined> = {
    status: values.status, client: values.clientId, q: values.q, sort: values.sort, dir: values.dir, cur: values.cur,
    limit: values.limit && values.limit !== 50 ? values.limit : null,
    ...patch,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null && value !== undefined && value !== "" && !(key === "status" && value === "all")) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `/invoices?${text}` : "/invoices";
}

export function showMoreHref(values: InvoiceFilterValues): string {
  return listHref(values, { limit: values.limit + 50 });
}

export function InvoicesEmpty({ filtered, tabLabel }: { filtered: boolean; tabLabel?: string }) {
  if (filtered) {
    return (
      <Card>
        <EmptyState
          title={tabLabel ? `No ${tabLabel.toLowerCase()} invoices here` : "No invoices match"}
          body="Try another tab, client or search term, or clear the filters to see everything."
          action={<LinkButton href="/invoices" variant="secondary">Clear filters</LinkButton>}
        />
      </Card>
    );
  }
  return (
    <Card>
      <EmptyState
        title="No invoices yet"
        body="Add an invoice by hand, or import a spreadsheet of them. Reminders are planned as soon as an invoice is added."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <LinkButton href="/invoices/new" variant="primary">New invoice</LinkButton>
            <LinkButton href="/invoices/import" variant="secondary">Import a CSV</LinkButton>
          </div>
        }
      />
    </Card>
  );
}
