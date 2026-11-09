// Message log (spec 3.3). Newest first, keyset-paginated at 50 rows. The cursor carries
// Postgres' own timestamp text, because a JavaScript Date keeps only milliseconds and
// would skip or repeat rows that share a millisecond with a page boundary.
import { withUser } from "@/lib/db";
import { DELIVERY_STATUSES, type DeliveryStatus } from "@/components/ops/kinds";
import { isUuid } from "./ops";

export { DELIVERY_STATUSES, DELIVERY_STATUS_LABEL, messageLogHref, type DeliveryStatus } from "@/components/ops/kinds";

export const MESSAGE_LOG_PAGE_SIZE = 50;

export const MESSAGE_SEARCH_MAX_LENGTH = 100;

export interface MessageLogFilters {
  status: DeliveryStatus | null;
  clientId: string | null;
  cursor: { sentAt: string; id: string } | null;
  // Free-text search over the client, invoice number, recipient and subject. Absent when empty.
  q?: string;
  // The message whose exact text is open below its row. Absent when none is.
  selectedId?: string;
}

// Unknown or malformed values are dropped, never passed to SQL. An invalid cursor starts
// the list again from the newest message.
export function parseMessageLogFilters(params: {
  status?: string;
  client?: string;
  cursor?: string;
  q?: string;
  id?: string;
}): MessageLogFilters {
  const status = (DELIVERY_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as DeliveryStatus)
    : null;
  const clientId = params.client && isUuid(params.client) ? params.client : null;
  const filters: MessageLogFilters = { status, clientId, cursor: decodeCursor(params.cursor) };
  const q = (params.q ?? "").replace(/\s+/g, " ").trim().slice(0, MESSAGE_SEARCH_MAX_LENGTH);
  if (q) filters.q = q;
  if (params.id && isUuid(params.id)) filters.selectedId = params.id;
  return filters;
}

// Escapes LIKE wildcards so a search is matched literally.
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function encodeCursor(sentAt: string, id: string): string {
  return Buffer.from(`${sentAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): { sentAt: string; id: string } | null {
  if (!raw || raw.length > 300) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [sentAt, id] = text.split("|");
  if (!sentAt || !id || !isUuid(id)) return null;
  // Postgres timestamptz text, for example "2026-11-09 10:00:00.123456+00".
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/.test(sentAt)) return null;
  return { sentAt, id };
}

export interface MessageLogRow {
  id: string;
  sentAt: string;
  recipientEmail: string;
  ccEmails: string[];
  subject: string;
  bodySnapshot: string;
  deliveryStatus: DeliveryStatus;
  manual: boolean;
  provider: string;
  providerMessageId: string | null;
  invoiceNumber: string | null;
  invoiceId: string | null;
  clientId: string | null;
  clientName: string | null;
  // The payable the reminder chased: its installment when it had one, else the invoice.
  amountMinor: number | null;
  currency: string | null;
}

export interface MessageLogPage {
  rows: MessageLogRow[];
  nextCursor: string | null;
}

interface LogSqlRow {
  id: string;
  sent_at_text: string;
  sent_at: Date;
  recipient_email: string;
  cc_emails: string[];
  subject: string;
  body_snapshot: string;
  delivery_status: DeliveryStatus;
  manual: boolean;
  provider: string;
  provider_message_id: string | null;
  invoice_number: string | null;
  invoice_id: string | null;
  client_id: string | null;
  client_name: string | null;
  amount_minor: string | null;
  currency: string | null;
}

const LOG_FROM = `
         from message_log m
         left join invoices i on i.id = m.invoice_id and i.user_id = m.user_id
         left join contacts ct on ct.id = m.contact_id and ct.user_id = m.user_id
         left join clients cl on cl.id = coalesce(i.client_id, ct.client_id) and cl.user_id = m.user_id`;

// The client and search conditions, shared by the list and the status counts.
function scopeWhere(filters: Pick<MessageLogFilters, "clientId" | "q">, params: unknown[]): string[] {
  const where: string[] = ["m.user_id = $1"];
  if (filters.clientId) {
    params.push(filters.clientId);
    where.push(`coalesce(i.client_id, ct.client_id) = $${params.length}`);
  }
  if (filters.q) {
    params.push(likePattern(filters.q));
    const n = params.length;
    where.push(`(cl.name ilike $${n} or i.invoice_number ilike $${n} or m.recipient_email ilike $${n} or m.subject ilike $${n})`);
  }
  return where;
}

export async function listMessageLog(userId: string, filters: MessageLogFilters): Promise<MessageLogPage> {
  return withUser(userId, async (c) => {
    const params: unknown[] = [userId];
    const where = scopeWhere(filters, params);
    if (filters.status) {
      params.push(filters.status);
      where.push(`m.delivery_status = $${params.length}`);
    }
    if (filters.cursor) {
      params.push(filters.cursor.sentAt, filters.cursor.id);
      where.push(`(m.sent_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(MESSAGE_LOG_PAGE_SIZE + 1);

    const { rows } = await c.query<LogSqlRow>(
      `select m.id, m.sent_at::text as sent_at_text, m.sent_at, m.recipient_email, m.cc_emails, m.subject,
              m.body_snapshot, m.delivery_status, m.manual, m.provider, m.provider_message_id,
              i.invoice_number, i.id as invoice_id, cl.id as client_id, cl.name as client_name,
              coalesce(p.amount_minor, i.amount_minor)::text as amount_minor, coalesce(p.currency, i.currency) as currency
         ${LOG_FROM}
         left join scheduled_messages sm on sm.id = m.scheduled_message_id and sm.user_id = m.user_id
         left join payment_plan_installments p on p.id = sm.installment_id and p.user_id = m.user_id
        where ${where.join(" and ")}
        order by m.sent_at desc, m.id desc
        limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > MESSAGE_LOG_PAGE_SIZE;
    const page = rows.slice(0, MESSAGE_LOG_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      rows: page.map((r) => ({
        id: r.id,
        sentAt: r.sent_at.toISOString(),
        recipientEmail: r.recipient_email,
        ccEmails: r.cc_emails ?? [],
        subject: r.subject,
        bodySnapshot: r.body_snapshot,
        deliveryStatus: r.delivery_status,
        manual: r.manual,
        provider: r.provider,
        providerMessageId: r.provider_message_id,
        invoiceNumber: r.invoice_number,
        invoiceId: r.invoice_id,
        clientId: r.client_id,
        clientName: r.client_name,
        amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
        currency: r.currency,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.sent_at_text, last.id) : null,
    };
  });
}

// Clients for the filter menu, by name.
export async function listClientOptions(userId: string): Promise<{ id: string; name: string }[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>(
      "select id, name from clients where user_id = $1 order by name, id",
      [userId],
    );
    return rows;
  });
}

// How many messages have each delivery status, within the client and search filters (the
// status tabs' counts). Every status is present, zero included.
export async function countMessageLogByStatus(
  userId: string,
  filters: Pick<MessageLogFilters, "clientId" | "q">,
): Promise<Record<DeliveryStatus | "all", number>> {
  return withUser(userId, async (c) => {
    const params: unknown[] = [userId];
    const where = scopeWhere(filters, params);
    const { rows } = await c.query<{ delivery_status: DeliveryStatus; n: string }>(
      `select m.delivery_status, count(*)::text as n ${LOG_FROM} where ${where.join(" and ")} group by m.delivery_status`,
      params,
    );
    const out: Record<DeliveryStatus | "all", number> = { all: 0, sent: 0, delivered: 0, bounced: 0, failed: 0 };
    for (const r of rows) {
      out[r.delivery_status] = Number(r.n);
      out.all += Number(r.n);
    }
    return out;
  });
}
