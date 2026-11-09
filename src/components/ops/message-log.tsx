// Message log view. Server-rendered, and it works without JavaScript: filters are a GET
// form and each row expands with <details> to show the exact body that was sent.
import Link from "next/link";
import { Badge, Button } from "@/components/ui";
import { DELIVERY_STATUS_LABEL, type DeliveryStatus, type MessageLogRow } from "@/lib/queries/messages";
import { formatClock, formatDay } from "@/lib/queries/ops";

const DELIVERY_TONE: Record<DeliveryStatus, "info" | "ok" | "danger"> = {
  sent: "info",
  delivered: "ok",
  bounced: "danger",
  failed: "danger",
};

export function MessageLogList({ rows, timezone }: { rows: MessageLogRow[]; timezone: string }) {
  return (
    <ol className="divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface shadow-card">
      {rows.map((row) => (
        <li key={row.id}>
          <details className="group">
            <summary className="flex min-h-14 cursor-pointer list-none flex-col gap-2 px-5 py-4 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-6 sm:px-6 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{row.recipientEmail}</span>
                <span className="block truncate text-[14px] text-ink-2">{row.subject}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:shrink-0">
                <Badge tone={DELIVERY_TONE[row.deliveryStatus]}>{DELIVERY_STATUS_LABEL[row.deliveryStatus]}</Badge>
                <time dateTime={row.sentAt} className="num text-[13px] text-ink-3">
                  {formatDay(row.sentAt, timezone)}, {formatClock(row.sentAt, timezone)}
                </time>
                <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-accent">
                  <span className="group-open:hidden">Show</span>
                  <span className="hidden group-open:inline">Hide</span>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="transition-transform group-open:rotate-180">
                    <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </span>
            </summary>
            <div className="flex flex-col gap-4 px-5 pb-6 sm:px-6">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-[13px] leading-5">
                <dt className="text-ink-3">Client</dt>
                <dd className="text-ink-2">{row.clientName ?? "Client removed"}</dd>
                <dt className="text-ink-3">Invoice</dt>
                <dd className="num text-ink-2">{row.invoiceNumber ?? "Invoice removed"}</dd>
                {row.ccEmails.length > 0 ? (
                  <>
                    <dt className="text-ink-3">Copied</dt>
                    <dd className="break-all text-ink-2">{row.ccEmails.join(", ")}</dd>
                  </>
                ) : null}
                <dt className="text-ink-3">Provider reference</dt>
                <dd className="break-all font-mono text-[12px] text-ink-2">{row.providerMessageId ?? "None recorded"}</dd>
                {row.manual ? (
                  <>
                    <dt className="text-ink-3">Recorded by</dt>
                    <dd className="text-ink-2">You marked it as sent after a delivery check</dd>
                  </>
                ) : null}
              </dl>
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">Exact text sent</p>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[12px] border border-line bg-surface-2 p-4 font-sans text-[14px] leading-6 text-ink-2">
                  {row.bodySnapshot}
                </pre>
              </div>
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

export function MessageLogPager({
  nextCursor,
  status,
  clientId,
}: {
  nextCursor: string | null;
  status: DeliveryStatus | null;
  clientId: string | null;
}) {
  if (!nextCursor) return null;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (clientId) params.set("client", clientId);
  params.set("cursor", nextCursor);
  return (
    <nav aria-label="Pages of messages" className="flex items-center justify-between gap-4 pt-2">
      <p className="text-[13px] text-ink-3">Newest first. 50 per page.</p>
      <Link
        href={`/messages?${params.toString()}`}
        className="inline-flex h-10 items-center rounded-[10px] border border-line-strong bg-surface px-4 text-sm font-medium text-ink no-underline shadow-card hover:border-ink-3 hover:bg-surface-2"
      >
        Older messages
      </Link>
    </nav>
  );
}
