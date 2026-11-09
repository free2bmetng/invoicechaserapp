// Dashboard totals (spec 3.6). Amounts are grouped by currency and never added across
// currencies. Outstanding covers open, payment_plan, paused and disputed payables.
// Overdue is an outstanding balance due strictly before today in the user's timezone.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { listClients, listNextSevenDays, type ClientListItem } from "@/lib/engine";
import { loadNeedsYou, loadSettingsView, localDay, type NeedsYouRow } from "./ops";

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
}

export interface DashboardData {
  timezone: string;
  onboardingDone: boolean;
  invoiceCount: number;
  totals: CurrencyTotals[];
  // The preview rows carry the step and planned date, so repeated titles can be told apart.
  needsYou: { total: number; preview: NeedsYouRow[] };
  plannedNext7Days: number;
  clients: ClientListItem[];
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
              coalesce(sum(amount) filter (where ($2::date - due_date) >= 61), 0)::text as age_61_plus
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
    }));
  });
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
  const today = localDay(clock.now(), settings.timezone);
  const [totals, count, needs, next7, clients, oldestOverdue] = await Promise.all([
    loadCurrencyTotals(userId, today),
    invoiceCount(userId),
    loadNeedsYou(userId),
    listNextSevenDays(userId, clock),
    listClients(userId, clock),
      loadOldestOverdueDays(userId, today),
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
    needsYou: { total: needs.total, preview: needsRows.slice(0, DASHBOARD_NEEDS_PREVIEW) },
    plannedNext7Days: next7.length,
    clients: sortedClients,
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
