// Data for the client screens: list sorting and search, the outstanding bar, and the header figures
// on a client's page. Sorting and filtering are pure so they can be tested without a database.
import { withUser } from "@/lib/db";
import { listClients, type ClientListItem, type MoneyTotal } from "@/lib/engine";
import type { Clock } from "@/lib/clock";

export const CLIENT_SORT_KEYS = ["name", "outstanding", "overdue", "pays", "contact"] as const;
export type ClientSortKey = (typeof CLIENT_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

// The first click on a column sorts the way people usually want it: names A to Z, the biggest
// amounts first, the slowest payers first, the most recent contact first.
export const FIRST_DIR: Record<ClientSortKey, SortDir> = {
  name: "asc",
  outstanding: "desc",
  overdue: "desc",
  pays: "desc",
  contact: "desc",
};

export const DEFAULT_CLIENT_SORT: { key: ClientSortKey; dir: SortDir } = { key: "overdue", dir: "desc" };

export function parseClientSort(sort: string | undefined, dir: string | undefined): { key: ClientSortKey; dir: SortDir } {
  const key = (CLIENT_SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as ClientSortKey) : DEFAULT_CLIENT_SORT.key;
  const d: SortDir = dir === "asc" || dir === "desc" ? dir : FIRST_DIR[key];
  return { key, dir: d };
}

// Amounts in different currencies cannot be added, so a client is ranked by its largest single
// currency line.
export function largestAmount(totals: readonly MoneyTotal[]): number {
  return totals.reduce((max, t) => Math.max(max, t.amountMinor), 0);
}

function byName(a: ClientListItem, b: ClientListItem): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

// Sorts a copy. Clients without a value (never paid, never contacted) always go last, whichever
// direction, so the useful rows stay on top. Ties fall back to the name.
export function sortClients(clients: readonly ClientListItem[], key: ClientSortKey, dir: SortDir): ClientListItem[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (c: ClientListItem): number | null => {
    switch (key) {
      case "outstanding":
        return largestAmount(c.outstanding);
      case "overdue":
        return largestAmount(c.overdue);
      case "pays":
        return c.avgDaysLate;
      case "contact":
        return c.lastContactAt ? c.lastContactAt.getTime() : null;
      default:
        return null;
    }
  };
  return [...clients].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return byName(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || byName(a, b);
  });
}

// Case-insensitive match on the client's name or email.
export function filterClients(clients: readonly ClientListItem[], q: string): ClientListItem[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return [...clients];
  return clients.filter((c) => c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle));
}

// The bar under each client's outstanding amount: its length is the client's share of the largest
// outstanding amount in the same currency, and the overdue part is drawn in the danger tone.
export interface OutstandingBar {
  currency: string;
  amountMinor: number;
  overdueMinor: number;
  // 0..1 of the largest outstanding amount in this currency across the list.
  share: number;
}

export function outstandingBars(clients: readonly ClientListItem[]): Map<string, OutstandingBar> {
  const maxByCurrency = new Map<string, number>();
  for (const c of clients) {
    for (const t of c.outstanding) maxByCurrency.set(t.currency, Math.max(maxByCurrency.get(t.currency) ?? 0, t.amountMinor));
  }
  const bars = new Map<string, OutstandingBar>();
  for (const c of clients) {
    const main = [...c.outstanding].sort((a, b) => b.amountMinor - a.amountMinor)[0];
    if (!main || main.amountMinor <= 0) continue;
    const max = maxByCurrency.get(main.currency) ?? main.amountMinor;
    const overdue = c.overdue.find((t) => t.currency === main.currency)?.amountMinor ?? 0;
    bars.set(c.id, {
      currency: main.currency,
      amountMinor: main.amountMinor,
      overdueMinor: Math.min(overdue, main.amountMinor),
      share: max > 0 ? main.amountMinor / max : 0,
    });
  }
  return bars;
}

// The four figures at the top of a client's page.
export interface ClientFigures {
  outstanding: MoneyTotal[];
  overdue: MoneyTotal[];
  // Mean days from due date to payment (negative is early). Null before the first paid invoice.
  avgDaysLate: number | null;
  averageDaysToPay: number | null;
  lastContactAt: Date | null;
  lastReplyAt: Date | null;
}

export async function loadClientFigures(userId: string, clientId: string, clock: Clock): Promise<ClientFigures | null> {
  const [rows, lastReplyAt] = await Promise.all([
    listClients(userId, clock),
    withUser(userId, async (c) => {
      const { rows } = await c.query<{ at: Date | null }>(
        "select max(created_at) as at from events where user_id = $1 and client_id = $2 and type = 'client_replied'",
        [userId, clientId],
      );
      return rows[0]?.at ?? null;
    }),
  ]);
  const summary = rows.find((c) => c.id === clientId);
  if (!summary) return null;
  return {
    outstanding: summary.outstanding.filter((t) => t.amountMinor > 0),
    overdue: summary.overdue.filter((t) => t.amountMinor > 0),
    avgDaysLate: summary.avgDaysLate,
    averageDaysToPay: summary.averageDaysToPay,
    lastContactAt: summary.lastContactAt,
    lastReplyAt: lastReplyAt ? new Date(lastReplyAt) : null,
  };
}

// The page title for a client, or null when it is not the user's.
export async function clientName(userId: string, clientId: string): Promise<string | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ name: string }>("select name from clients where id = $1 and user_id = $2", [clientId, userId]);
    return rows[0]?.name ?? null;
  });
}
