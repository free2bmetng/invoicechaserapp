// The clients list. Server-rendered from the engine's listClients read. Wide screens show one header
// row above the rows. Phones label each value inline and drop empty values, so no dash stacks up.
import Link from "next/link";
import type { ClientListItem } from "@/lib/engine";
import { Money } from "@/components/money";
import { dayLabelFor, lateLabel } from "@/components/invoices/format";

// Largest overdue amount first. Amounts in different currencies are compared by their largest single
// currency line, because they cannot be added. Clients with nothing overdue go last, by name.
export function sortByOverdue(clients: ClientListItem[]): ClientListItem[] {
  const largest = (c: ClientListItem) => c.overdue.reduce((max, t) => Math.max(max, t.amountMinor), 0);
  return [...clients].sort((a, b) => largest(b) - largest(a) || a.name.localeCompare(b.name, "en"));
}

const COLUMNS = "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] sm:items-center sm:gap-5";

function Empty() {
  return <span className="hidden text-ink-3 sm:inline">—</span>;
}

export function ClientRows({ clients, zone }: { clients: ClientListItem[]; zone: string }) {
  return (
    <div className="grid gap-3">
      <div aria-hidden="true" className={`hidden px-5 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3 sm:grid ${COLUMNS}`}>
        <span>Client</span>
        <span>Overdue</span>
        <span>Typically pays</span>
        <span>Last contact</span>
      </div>
      <ul aria-label="Clients" className="grid gap-3">
        {clients.map((c) => (
          <li key={c.id}>
            <Link
              href={`/clients/${c.id}`}
              className={`grid gap-3 rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-4 shadow-card transition-colors duration-150 hover:border-line-strong hover:bg-surface-2/50 sm:px-5 ${COLUMNS}`}
            >
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-ink">{c.name}</p>
                <p className="truncate text-[13px] text-ink-2">{c.email}</p>
                {c.replyHeldAt || c.autoSend ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.replyHeldAt ? (
                      <span className="rounded-full border border-warn/25 bg-warn-soft px-2 py-0.5 text-[12px] font-medium text-warn">Replied · on hold</span>
                    ) : null}
                    {c.autoSend ? (
                      <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">Auto-send on</span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] sm:block">
                <span className="text-ink-3 sm:hidden">Overdue</span>
                {c.overdue.length === 0 ? <Empty /> : null}
                {c.overdue.map((t) => (
                  <span key={t.currency} className="block font-medium text-warn"><Money minor={t.amountMinor} currency={t.currency} /></span>
                ))}
              </div>

              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-2 sm:block">
                <span className="text-ink-3 sm:hidden">Typically pays</span>
                {lateLabel(c.avgDaysLate) === null ? <Empty /> : <span className="num">{lateLabel(c.avgDaysLate)}</span>}
              </div>

              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-2 sm:block">
                <span className="text-ink-3 sm:hidden">Last contact</span>
                {c.lastContactAt ? <span className="num">{dayLabelFor(c.lastContactAt.toISOString(), zone)}</span> : <Empty />}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
