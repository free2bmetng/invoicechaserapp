// The clients table. Server-rendered: sorting is a set of links, and each row is one link to the
// client. On a phone each row is two lines: the client and what they owe, then the labelled facts.
import type { ClientListItem } from "@/lib/engine";
import { Card, cx } from "@/components/ui";
import { Money } from "@/components/money";
import { Table, TBody, THead, Td, Th, Tr } from "@/components/data";
import { dayLabelFor, lateLabel } from "@/components/invoices/format";
import {
  FIRST_DIR, outstandingBars, sortClients, type ClientSortKey, type OutstandingBar, type SortDir,
} from "@/app/(app)/clients/client-data";

// Kept for older callers: largest overdue amount first.
export function sortByOverdue(clients: ClientListItem[]): ClientListItem[] {
  return sortClients(clients, "overdue", "desc");
}

export function clientsHref(params: { q?: string; sort?: ClientSortKey; dir?: SortDir; add?: boolean }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.sort) sp.set("sort", params.sort);
  if (params.dir) sp.set("dir", params.dir);
  if (params.add) sp.set("add", "1");
  const s = sp.toString();
  return s ? `/clients?${s}` : "/clients";
}

function Bar({ bar }: { bar: OutstandingBar }) {
  const overdueShare = bar.amountMinor > 0 ? bar.overdueMinor / bar.amountMinor : 0;
  return (
    <span aria-hidden="true" className="mt-1.5 ml-auto flex h-1 w-24 justify-end overflow-hidden rounded-full bg-surface-3 max-sm:hidden">
      <span className="flex h-full min-w-[3px] overflow-hidden rounded-full" style={{ width: `${Math.max(3, bar.share * 100)}%` }}>
        <span className="h-full bg-neutral-fill" style={{ flexGrow: 1 - overdueShare }} />
        <span className="h-full bg-danger-fill" style={{ flexGrow: overdueShare }} />
      </span>
    </span>
  );
}

function Amounts({ totals, tone }: { totals: { currency: string; amountMinor: number }[]; tone?: "danger" }) {
  const shown = totals.filter((t) => t.amountMinor > 0);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex flex-col items-end gap-0.5 max-sm:inline">
      {shown.map((t, i) => (
        <span key={t.currency} className={cx(tone === "danger" && "text-danger")}>
          {i > 0 ? <span aria-hidden="true" className="text-ink-3 sm:hidden"> · </span> : null}
          <Money minor={t.amountMinor} currency={t.currency} />
        </span>
      ))}
    </span>
  );
}

export function ClientTable({
  clients,
  zone,
  sort,
  q,
}: {
  clients: ClientListItem[];
  zone: string;
  sort: { key: ClientSortKey; dir: SortDir };
  q: string;
}) {
  const bars = outstandingBars(clients);
  const th = (key: ClientSortKey) => {
    const active = sort.key === key;
    const nextDir: SortDir = active ? (sort.dir === "asc" ? "desc" : "asc") : FIRST_DIR[key];
    return { sortHref: clientsHref({ q, sort: key, dir: nextDir }), sorted: active ? sort.dir : undefined };
  };
  return (
    <Card className="overflow-hidden">
      <Table label="Clients">
        <THead>
          <Th {...th("name")}>Client</Th>
          <Th align="right" {...th("outstanding")}>Outstanding</Th>
          <Th align="right" {...th("overdue")}>Overdue</Th>
          <Th {...th("pays")}>Typically pays</Th>
          <Th {...th("contact")}>Last contact</Th>
        </THead>
        <TBody>
          {clients.map((c) => {
            const bar = bars.get(c.id);
            const overdue = c.overdue.some((t) => t.amountMinor > 0);
            const pays = lateLabel(c.avgDaysLate);
            return (
              <Tr key={c.id} href={`/clients/${c.id}`} tone={overdue ? "danger" : undefined}>
                <Td primary>
                  <span className="block min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-ink">{c.name}</span>
                      {c.replyHeldAt ? (
                        <span className="shrink-0 rounded-full bg-warn-soft px-1.5 text-[11.5px] leading-5 font-medium text-warn">Replied</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-small font-normal text-ink-3 max-sm:hidden">{c.email}</span>
                  </span>
                </Td>
                <Td numeric primary>
                  {c.outstanding.some((t) => t.amountMinor > 0) ? (
                    <span className="inline-block text-right">
                      <Amounts totals={c.outstanding} />
                      {bar ? <Bar bar={bar} /> : null}
                    </span>
                  ) : (
                    <span className="text-ink-3 max-sm:hidden">Nothing owed</span>
                  )}
                </Td>
                <Td numeric label="Overdue">
                  {overdue ? <Amounts totals={c.overdue} tone="danger" /> : null}
                </Td>
                <Td label="Pays">
                  {pays ? <span className={cx("num", c.avgDaysLate !== null && c.avgDaysLate > 14 && "text-warn")}>{pays}</span> : null}
                </Td>
                <Td label="Last contact">
                  {c.lastContactAt ? <span className="num whitespace-nowrap">{dayLabelFor(c.lastContactAt.toISOString(), zone)}</span> : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}
