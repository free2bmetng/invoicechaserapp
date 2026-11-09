// Dashboard totals (spec 3.6). Amounts are grouped by currency and never added across
// currencies. Outstanding covers open, payment_plan, paused and disputed payables.
// Overdue is an outstanding balance due strictly before today in the user's timezone.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { listClients, listNextSevenDays, type ClientListItem } from "@/lib/engine";
import { loadNeedsYou, loadSettingsView, localDay, type MoneyAmount, type NeedsYouRow } from "./ops";

export interface AgeBuckets {
  // Minor units. Days overdue = today minus the due date.
  days1to30: number;
  days31to60: number;
  days61plus: number;
}

export interface CurrencyTotals {
  currency: string;
  outstandingMinor: number;
  overdueMinor: number;
  overdueByAge: AgeBuckets;
  // Outstanding but not yet overdue (due today or later).
  notDueMinor: number;
  // Due from today to six days ahead, not yet overdue.
  dueThisWeekMinor: number;
  // Payables (invoices, or open installments of a plan) behind each figure.
  counts: { outstanding: number; overdue: number; notDue: number; dueThisWeek: number } & AgeBuckets;
}

// Why an unpaid invoice is or is not being chased right now (the "Ready to chase" card).
export type ChaseState = "ready" | "approval" | "held" | "paused" | "disputed" | "ended";

export interface ChaseSummary {
  state: ChaseState;
  invoices: number;
  totals: MoneyAmount[];
}

export interface ReadyToChase {
  // One entry per state that has invoices, in display order; "ready" first.
  states: ChaseSummary[];
  // The earliest planned time of a queued reminder (ISO), or null when nothing is queued.
  nextSendAt: string | null;
}

export interface DashboardData {
  timezone: string;
  onboardingDone: boolean;
  invoiceCount: number;
  totals: CurrencyTotals[];
  // The preview rows carry the step and planned date, so repeated titles can be told apart.
  // Ordered by urgency: failed sends, delivery checks and bounces come before approvals.
  needsYou: { total: number; preview: NeedsYouRow[]; byKind: Partial<Record<NeedsYouRow["kind"], number>> };
  plannedNext7Days: number;
  clients: ClientListItem[];
  // Days since the due date of each client's oldest overdue payable. Absent: nothing overdue.
  oldestOverdueDays: Record<string, number>;
  // When the figures were read (ISO), shown as "as of" beside the totals.
  asOf: string;
  // The currency with the most unpaid payables leads the summary. Others are listed after it.
  primaryCurrency: string | null;
  readyToChase: ReadyToChase;
}

export const DASHBOARD_NEEDS_PREVIEW = 5;

// Per-currency totals for the given local date (YYYY-MM-DD). Installments of a payment
// plan are payables in their own right, so only their open rows count.
export async function loadCurrencyTotals(userId: string, today: string): Promise<CurrencyTotals[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      currency: string;
      outstanding: string;
      overdue: string;
      age_1_30: string;
      age_31_60: string;
      age_61_plus: string;
      not_due: string;
      due_week: string;
      n_outstanding: string;
      n_overdue: string;
      n_1_30: string;
      n_31_60: string;
      n_61_plus: string;
      n_not_due: string;
      n_due_week: string;
    }>(
      `with payables as (
         select i.currency, i.amount_minor as amount, i.due_date
           from invoices i
          where i.user_id = $1 and i.status in ('open', 'paused', 'disputed')
            and not exists (select 1 from payment_plan_installments p where p.invoice_id = i.id)
         union all
         select p.currency, p.amount_minor, p.due_date
           from payment_plan_installments p join invoices i on i.id = p.invoice_id
          where p.user_id = $1 and p.status = 'open' and i.status in ('open', 'payment_plan', 'paused', 'disputed')
       )
       select currency,
              coalesce(sum(amount), 0)::text as outstanding,
              coalesce(sum(amount) filter (where due_date < $2::date), 0)::text as overdue,
              coalesce(sum(amount) filter (where ($2::date - due_date) between 1 and 30), 0)::text as age_1_30,
              coalesce(sum(amount) filter (where ($2::date - due_date) between 31 and 60), 0)::text as age_31_60,
              coalesce(sum(amount) filter (where ($2::date - due_date) >= 61), 0)::text as age_61_plus,
              coalesce(sum(amount) filter (where due_date >= $2::date), 0)::text as not_due,
              coalesce(sum(amount) filter (where due_date between $2::date and $2::date + 6), 0)::text as due_week,
              count(*)::text as n_outstanding,
              (count(*) filter (where due_date < $2::date))::text as n_overdue,
              (count(*) filter (where ($2::date - due_date) between 1 and 30))::text as n_1_30,
              (count(*) filter (where ($2::date - due_date) between 31 and 60))::text as n_31_60,
              (count(*) filter (where ($2::date - due_date) >= 61))::text as n_61_plus,
              (count(*) filter (where due_date >= $2::date))::text as n_not_due,
              (count(*) filter (where due_date between $2::date and $2::date + 6))::text as n_due_week
         from payables
        group by currency
        order by currency`,
      [userId, today],
    );
    return rows.map((r) => ({
      currency: r.currency,
      outstandingMinor: Number(r.outstanding),
      overdueMinor: Number(r.overdue),
      overdueByAge: {
        days1to30: Number(r.age_1_30),
        days31to60: Number(r.age_31_60),
        days61plus: Number(r.age_61_plus),
      },
      notDueMinor: Number(r.not_due),
      dueThisWeekMinor: Number(r.due_week),
      counts: {
        outstanding: Number(r.n_outstanding),
        overdue: Number(r.n_overdue),
        notDue: Number(r.n_not_due),
        dueThisWeek: Number(r.n_due_week),
        days1to30: Number(r.n_1_30),
        days31to60: Number(r.n_31_60),
        days61plus: Number(r.n_61_plus),
      },
    }));
  });
}

const CHASE_ORDER: ChaseState[] = ["ready", "approval", "held", "paused", "disputed", "ended"];

// Every unpaid invoice, classified by whether a reminder is queued for it and, if not, why not.
// A disputed or paused invoice is reported as such first; then a queued reminder makes it ready;
// then one awaiting approval; then one on hold (a reply or bounce); otherwise its sequence has
// no reminders left. Amounts stay per currency.
export async function loadReadyToChase(userId: string): Promise<ReadyToChase> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ invoice_id: string; currency: string; amount: string; state: ChaseState; next_at: Date | null }>(
      `with payables as (
         select i.id as invoice_id, i.status, i.currency, i.amount_minor as amount
           from invoices i
          where i.user_id = $1 and i.status in ('open', 'paused', 'disputed')
            and not exists (select 1 from payment_plan_installments p where p.invoice_id = i.id)
         union all
         select i.id, i.status, p.currency, p.amount_minor
           from payment_plan_installments p join invoices i on i.id = p.invoice_id
          where p.user_id = $1 and p.status = 'open' and i.status in ('open', 'payment_plan', 'paused', 'disputed')
       ),
       inv as (
         select invoice_id, max(status) as status, currency, sum(amount) as amount
           from payables group by invoice_id, currency
       ),
       msg as (
         select invoice_id,
                bool_or(status = 'scheduled') as has_scheduled,
                bool_or(status = 'pending_approval') as has_pending,
                bool_or(status = 'held') as has_held,
                min(planned_at) filter (where status = 'scheduled') as next_at
           from scheduled_messages
          where user_id = $1 and status in ('scheduled', 'pending_approval', 'held')
          group by invoice_id
       )
       select inv.invoice_id, inv.currency, inv.amount::text as amount,
              case when inv.status = 'disputed' then 'disputed'
                   when inv.status = 'paused' then 'paused'
                   when m.has_scheduled then 'ready'
                   when m.has_pending then 'approval'
                   when m.has_held then 'held'
                   else 'ended' end as state,
              m.next_at
         from inv left join msg m on m.invoice_id = inv.invoice_id
        order by inv.currency`,
      [userId],
    );
    const byState = new Map<ChaseState, { invoices: Set<string>; totals: Map<string, number> }>();
    let nextSendAt: Date | null = null;
    for (const r of rows) {
      const entry = byState.get(r.state) ?? { invoices: new Set<string>(), totals: new Map<string, number>() };
      entry.invoices.add(r.invoice_id);
      entry.totals.set(r.currency, (entry.totals.get(r.currency) ?? 0) + Number(r.amount));
      byState.set(r.state, entry);
      if (r.state === "ready" && r.next_at && (!nextSendAt || r.next_at < nextSendAt)) nextSendAt = r.next_at;
    }
    return {
      states: CHASE_ORDER.flatMap((state) => {
        const entry = byState.get(state);
        if (!entry) return [];
        return [
          {
            state,
            invoices: entry.invoices.size,
            totals: [...entry.totals.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })),
          },
        ];
      }),
      nextSendAt: nextSendAt ? nextSendAt.toISOString() : null,
    };
  });
}

// The currency with the most unpaid payables, by count (amounts are never compared across
// currencies). Ties go to the alphabetically first code.
export function primaryCurrencyOf(totals: readonly CurrencyTotals[]): string | null {
  let best: CurrencyTotals | null = null;
  for (const t of totals) if (!best || t.counts.outstanding > best.counts.outstanding) best = t;
  return best?.currency ?? null;
}

// For each client with money overdue, the age in days of its oldest overdue payable, measured from
// the due date to today. Installments count as payables. Nothing is converted between currencies.
export async function loadOldestOverdueDays(userId: string, today: string): Promise<Map<string, number>> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ client_id: string; days: string }>(
      `with payables as (
         select i.client_id, i.due_date
           from invoices i
          where i.user_id = $1 and i.status in ('open', 'paused', 'disputed')
            and not exists (select 1 from payment_plan_installments p where p.invoice_id = i.id)
         union all
         select i.client_id, p.due_date
           from payment_plan_installments p join invoices i on i.id = p.invoice_id
          where p.user_id = $1 and p.status = 'open' and i.status in ('open', 'payment_plan', 'paused', 'disputed')
       )
       select client_id, max(($2::date - due_date))::text as days
         from payables
        where due_date < $2::date
        group by client_id`,
      [userId, today],
    );
    return new Map(rows.map((r) => [r.client_id, Number(r.days)]));
  });
}

async function invoiceCount(userId: string): Promise<number> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ n: string }>("select count(*)::text as n from invoices where user_id = $1", [userId]);
    return Number(rows[0]?.n ?? 0);
  });
}

async function loadDashboardData(userId: string, clock: Clock, settings: { timezone: string; onboardingDone: boolean }): Promise<DashboardData> {
  const now = clock.now();
  const today = localDay(now, settings.timezone);
  const [totals, count, needs, next7, clients, oldestOverdue, readyToChase] = await Promise.all([
    loadCurrencyTotals(userId, today),
    invoiceCount(userId),
    loadNeedsYou(userId),
    listNextSevenDays(userId, clock),
    listClients(userId, clock),
    loadOldestOverdueDays(userId, today),
    loadReadyToChase(userId),
  ]);
  const needsRows = needs.sections.flatMap((section) => section.rows);

  // Clients ordered by the age of their oldest overdue invoice, in days, largest first.
  // Clients with nothing overdue come after, by name. Amounts are never compared across currencies.
  const sortedClients = [...clients].sort((a, b) => {
    const aDays = oldestOverdue.get(a.id);
    const bDays = oldestOverdue.get(b.id);
    if (aDays !== undefined && bDays !== undefined) return bDays - aDays || a.name.localeCompare(b.name);
    if (aDays !== undefined) return -1;
    if (bDays !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    timezone: settings.timezone,
    onboardingDone: settings.onboardingDone,
    invoiceCount: count,
    totals,
    needsYou: {
      total: needs.total,
      preview: needsRows.slice(0, DASHBOARD_NEEDS_PREVIEW),
      byKind: Object.fromEntries(needs.sections.map((section) => [section.kind, section.rows.length])),
    },
    plannedNext7Days: next7.length,
    clients: sortedClients,
    oldestOverdueDays: Object.fromEntries(oldestOverdue),
    asOf: now.toISOString(),
    primaryCurrency: primaryCurrencyOf(totals),
    readyToChase,
  };
}

export type DashboardState =
  | { kind: "onboarding" }
  | { kind: "empty" }
  | { kind: "ready"; data: DashboardData };

// The dashboard's gate. Onboarding is checked first, before any dashboard data is read,
// so a user who has not finished setup is sent to /onboarding straight away.
export async function loadDashboardState(userId: string, clock: Clock): Promise<DashboardState> {
  const settings = await loadSettingsView(userId);
  if (!settings.onboardingDone) return { kind: "onboarding" };
  const data = await loadDashboardData(userId, clock, settings);
  if (data.invoiceCount === 0) return { kind: "empty" };
  return { kind: "ready", data };
}
