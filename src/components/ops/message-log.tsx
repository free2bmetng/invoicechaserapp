// Message log view. Server-rendered, and it works without JavaScript: each row is a link that
// opens the exact message under it (?id=), and the URL keeps the filters.
import Link from "next/link";
import { DateTime } from "luxon";
import {
  SegmentedTabs,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@/components/data";
import { Money } from "@/components/money";
import { MessageStatusBadge } from "@/components/status";
import { buttonClass } from "@/components/ui";
import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUSES,
  messageLogHref,
  type DeliveryStatus,
} from "./kinds";
import type { MessageLogRow } from "@/lib/queries/messages";
import { formatTimelineTime } from "@/components/data";

const COLUMNS = 6;

// "9 Nov, 2:05 PM", with the year when it is not this year.
function shortStamp(iso: string, zone: string, now: DateTime): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" })
    .setZone(zone)
    .setLocale("en");
  return dt.toFormat(
    dt.year === now.setZone(zone).year ? "d LLL, h:mm a" : "d LLL yyyy, h:mm a",
  );
}

export interface LogView {
  status: DeliveryStatus | null;
  clientId: string | null;
  q: string | null;
  cursor: string | null;
  selectedId: string | null;
}

export function StatusTabs({
  view,
  counts,
}: {
  view: LogView;
  counts: Record<DeliveryStatus | "all", number>;
}) {
  const base = { client: view.clientId, q: view.q };
  return (
    <SegmentedTabs
      label="Delivery status"
      items={[
        {
          label: "All",
          href: messageLogHref(base),
          count: counts.all,
          active: view.status === null,
        },
        ...DELIVERY_STATUSES.map((status) => ({
          label: DELIVERY_STATUS_LABEL[status],
          href: messageLogHref({ ...base, status }),
          count: counts[status],
          active: view.status === status,
        })),
      ]}
    />
  );
}

function MessageDetail({
  row,
  timezone,
  closeHref,
}: {
  row: MessageLogRow;
  timezone: string;
  closeHref: string;
}) {
  return (
    <section
      aria-label={`Message to ${row.clientName ?? row.recipientEmail}`}
      className="flex flex-col gap-4 lg:flex-row lg:gap-6"
    >
      <dl className="grid shrink-0 grid-cols-[5.5rem_minmax(0,1fr)] content-start gap-x-3 gap-y-1.5 text-small lg:w-72">
        <dt className="text-ink-3">To</dt>
        <dd className="min-w-0 break-all text-ink">{row.recipientEmail}</dd>
        {row.ccEmails.length > 0 ? (
          <>
            <dt className="text-ink-3">Copied</dt>
            <dd className="min-w-0 break-all text-ink-2">
              {row.ccEmails.join(", ")}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-3">Sent</dt>
        <dd className="num text-ink-2">
          {formatTimelineTime(row.sentAt, timezone)}
        </dd>
        <dt className="text-ink-3">Status</dt>
        <dd>
          <MessageStatusBadge status={row.deliveryStatus} />
        </dd>
        {row.manual ? (
          <>
            <dt className="text-ink-3">Recorded</dt>
            <dd className="text-ink-2">By you, after a delivery check</dd>
          </>
        ) : null}
        <dd className="col-span-2 mt-2 flex flex-wrap gap-2">
          {row.invoiceId ? (
            <Link
              href={`/invoices/${row.invoiceId}`}
              className={buttonClass("secondary", "sm")}
            >
              Open invoice
            </Link>
          ) : null}
          <Link
            href={closeHref}
            scroll={false}
            className={buttonClass("ghost", "sm")}
          >
            Close
          </Link>
        </dd>
      </dl>
      <figure className="min-w-0 flex-1 overflow-hidden rounded-[12px] border border-line bg-surface">
        <figcaption className="border-b border-line bg-surface-2 px-4 py-2.5 text-body font-medium break-words text-ink">
          {row.subject}
        </figcaption>
        <pre className="max-h-[28rem] overflow-auto px-4 py-4 font-sans text-body whitespace-pre-wrap break-words text-ink-2">
          {row.bodySnapshot}
        </pre>
      </figure>
    </section>
  );
}

export function MessageLogTable({
  rows,
  timezone,
  view,
}: {
  rows: MessageLogRow[];
  timezone: string;
  view: LogView;
}) {
  const now = DateTime.now();
  const base = {
    status: view.status,
    client: view.clientId,
    q: view.q,
    cursor: view.cursor,
  };
  return (
    <div className="[&_tr:has([aria-current=true])]:bg-surface-2">
      <Table label="Messages sent, newest first">
        <THead>
          <Th>Client</Th>
          <Th>Invoice</Th>
          <Th>Subject</Th>
          <Th align="right">Amount</Th>
          <Th>Status</Th>
          <Th align="right">Sent</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const open = row.id === view.selectedId;
            const href = open
              ? messageLogHref(base)
              : `${messageLogHref({ ...base, id: row.id })}#msg-${row.id}`;
            return [
              <Tr
                key={row.id}
                href={href}
                tone={
                  row.deliveryStatus === "bounced" ||
                  row.deliveryStatus === "failed"
                    ? "danger"
                    : undefined
                }
              >
                <Td primary>
                  <span
                    id={`msg-${row.id}`}
                    className="scroll-mt-24"
                    aria-current={open ? "true" : undefined}
                  >
                    {row.clientName ?? row.recipientEmail}
                  </span>
                </Td>
                <Td>{row.invoiceNumber}</Td>
                <Td>
                  <span className="block max-w-[22rem] truncate max-sm:max-w-[calc(100vw-4rem)]">
                    {row.subject}
                  </span>
                </Td>
                <Td primary numeric>
                  {row.amountMinor !== null && row.currency ? (
                    <Money
                      minor={row.amountMinor}
                      currency={row.currency}
                      className="text-ink"
                    />
                  ) : null}
                </Td>
                <Td>
                  <MessageStatusBadge status={row.deliveryStatus} />
                </Td>
                <Td align="right">
                  <time dateTime={row.sentAt} className="num whitespace-nowrap">
                    {shortStamp(row.sentAt, timezone, now)}
                  </time>
                </Td>
              </Tr>,
              open ? (
                <tr
                  key={`${row.id}-detail`}
                  className="border-b border-line bg-surface-2 max-sm:block"
                >
                  <td
                    colSpan={COLUMNS}
                    className="px-4 py-4 max-sm:block sm:px-5 sm:py-5"
                  >
                    <MessageDetail
                      row={row}
                      timezone={timezone}
                      closeHref={messageLogHref(base)}
                    />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </TBody>
      </Table>
    </div>
  );
}

export function MessageLogPager({
  nextCursor,
  view,
  shown,
}: {
  nextCursor: string | null;
  view: LogView;
  shown: number;
}) {
  if (!nextCursor && !view.cursor) return null;
  const base = { status: view.status, client: view.clientId, q: view.q };
  return (
    <nav
      aria-label="Pages of messages"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-small text-ink-3">
        {shown} {shown === 1 ? "message" : "messages"} on this page, newest
        first.
      </p>
      <div className="flex gap-2">
        {view.cursor ? (
          <Link
            href={messageLogHref(base)}
            className={buttonClass("ghost", "sm")}
          >
            Back to newest
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            href={messageLogHref({ ...base, cursor: nextCursor })}
            className={buttonClass("secondary", "sm")}
          >
            Older messages
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
