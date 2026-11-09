// Full data export: a zip with one CSV per user table, read through withUser so
// row-level security applies. Columns are listed explicitly, so secrets are never
// selected: connected_accounts.secret_ciphertext is omitted. Date columns are cast
// to text so the pg driver does not shift them into local time.
import { strToU8, zipSync } from "fflate";
import { writeCsv } from "./csv";
import { withUser } from "./db";
import { csvSafeCell } from "./formulas";

interface TableExport {
  // File name without ".csv".
  file: string;
  from: string;
  orderBy: string;
  // Select expressions. "expr as alias" when the header differs from the column.
  columns: readonly string[];
}

const TABLES: readonly TableExport[] = [
  {
    file: "users",
    from: "users",
    orderBy: "created_at, id",
    columns: ["id", "email", "created_at"],
  },
  {
    file: "settings",
    from: "settings",
    orderBy: "user_id",
    columns: [
      "user_id",
      "sender_name",
      "business_name",
      "postal_address",
      "timezone",
      "send_window_start",
      "send_window_end",
      "daily_cap",
      "digest_hour",
      "digest_enabled",
      "sending_provider",
      "sending_domain",
      "onboarding_done",
      "updated_at",
    ],
  },
  {
    file: "clients",
    from: "clients",
    orderBy: "created_at, id",
    columns: ["id", "user_id", "name", "email", "timezone", "sequence_id", "auto_send", "reply_held_at", "created_at"],
  },
  {
    file: "contacts",
    from: "contacts",
    orderBy: "created_at, id",
    columns: ["id", "user_id", "client_id", "email", "name", "is_primary", "hold", "created_at"],
  },
  {
    file: "sequences",
    from: "sequences",
    orderBy: "created_at, id",
    columns: ["id", "user_id", "name", "kind", "is_default", "created_at"],
  },
  {
    file: "sequence_steps",
    from: "sequence_steps",
    orderBy: "sequence_id, position",
    columns: [
      "id",
      "user_id",
      "sequence_id",
      "position",
      "offset_days",
      "tone",
      "subject",
      "body",
      "requires_approval",
      "is_final_notice",
    ],
  },
  {
    file: "invoices",
    from: "invoices",
    orderBy: "created_at, id",
    columns: [
      "id",
      "user_id",
      "client_id",
      "invoice_number",
      "amount_minor",
      "currency",
      "issue_date::text as issue_date",
      "due_date::text as due_date",
      "status",
      "paid_at",
      "notes",
      "sequence_id",
      "source",
      "external_id",
      "stripe_payment_link_id",
      "stripe_payment_link_url",
      "stripe_link_amount_minor",
      "created_at",
      "updated_at",
    ],
  },
  {
    file: "invoice_contacts",
    from: "invoice_contacts",
    orderBy: "invoice_id, contact_id",
    columns: ["user_id", "invoice_id", "contact_id", "role"],
  },
  {
    file: "payment_plan_installments",
    from: "payment_plan_installments",
    orderBy: "invoice_id, position",
    columns: [
      "id",
      "user_id",
      "invoice_id",
      "position",
      "due_date::text as due_date",
      "amount_minor",
      "currency",
      "status",
      "paid_at",
      "stripe_payment_link_id",
      "stripe_payment_link_url",
      "stripe_link_amount_minor",
    ],
  },
  {
    file: "scheduled_messages",
    from: "scheduled_messages",
    orderBy: "planned_at, id",
    columns: [
      "id",
      "user_id",
      "invoice_id",
      "installment_id",
      "step_id",
      "contact_id",
      "planned_at",
      "status",
      "prior_status",
      "requires_approval",
      "subject_override",
      "body_override",
      "claimed_at",
      "dedupe_key",
      "created_at",
      "updated_at",
    ],
  },
  {
    file: "message_log",
    from: "message_log",
    orderBy: "sent_at, id",
    columns: [
      "id",
      "user_id",
      "scheduled_message_id",
      "invoice_id",
      "contact_id",
      "recipient_email",
      "cc_emails",
      "subject",
      "body_snapshot",
      "provider",
      "provider_message_id",
      "sent_at",
      "delivery_status",
      "manual",
    ],
  },
  {
    file: "events",
    from: "events",
    orderBy: "created_at, id",
    columns: ["id", "user_id", "invoice_id", "client_id", "type", "detail", "created_at"],
  },
  {
    // secret_ciphertext is deliberately not listed.
    file: "connected_accounts",
    from: "connected_accounts",
    orderBy: "created_at, id",
    columns: ["id", "user_id", "provider", "account_label", "created_at"],
  },
  {
    file: "stripe_events",
    from: "stripe_events",
    orderBy: "processed_at, event_id",
    columns: ["event_id", "user_id", "processed_at"],
  },
  {
    file: "digests",
    from: "digests",
    orderBy: "digest_date, user_id",
    columns: ["user_id", "digest_date::text as digest_date", "sent_at"],
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headerOf(column: string): string {
  const match = /\s+as\s+(\w+)$/i.exec(column);
  return match ? match[1] : column;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export async function exportUserData(userId: string): Promise<Uint8Array> {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new TypeError("exportUserData expects a user id (UUID).");

  const files: Record<string, Uint8Array> = {};
  await withUser(userId, async (client) => {
    for (const table of TABLES) {
      const headers = table.columns.map((column) => csvSafeCell(headerOf(column)));
      const { rows } = await client.query(
        `select ${table.columns.join(", ")} from ${table.from} order by ${table.orderBy}`,
      );
      const body = rows.map((row) =>
        table.columns.map((column) => csvSafeCell(cellText((row as Record<string, unknown>)[headerOf(column)]))),
      );
      files[`${table.file}.csv`] = strToU8(writeCsv([headers, ...body]));
    }
  });

  return zipSync(files, { level: 6 });
}
