// Runs against the real Postgres test database, because row-level security is
// what keeps one user's export from containing another user's rows.
import { parse } from "csv-parse/sync";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { encryptSecret } from "@/lib/crypto";
import { closeDb } from "@/lib/db";
import { exportUserData } from "@/lib/export";

const EXPECTED_FILES = [
  "clients.csv",
  "connected_accounts.csv",
  "contacts.csv",
  "digests.csv",
  "events.csv",
  "invoice_contacts.csv",
  "invoices.csv",
  "message_log.csv",
  "payment_plan_installments.csv",
  "scheduled_messages.csv",
  "sequence_steps.csv",
  "sequences.csv",
  "settings.csv",
  "stripe_events.csv",
  "users.csv",
];

const SECRET = "rk_live_TESTSECRETVALUE_123";
const FORMULA_NAME = '=HYPERLINK("https://evil.example.test","Click")';

let ORIGINAL_TZ: string | undefined;

beforeAll(() => {
  // A zone behind UTC, so a date that reaches the driver as local midnight would shift a day.
  ORIGINAL_TZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
});

afterAll(async () => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  await closeDb();
});

async function one<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await adminQuery<T>(sql, params);
  return rows[0] as T;
}

interface Seeded {
  userA: string;
  userB: string;
  ciphertext: string;
}

// Gives user A one row or more in every table, and user B data that must never leak into A's export.
async function seed(): Promise<Seeded> {
  const userA = await createUser("owner-a@example.test");
  const userB = await createUser("owner-b@example.test");

  await adminQuery(
    `insert into settings (user_id, sender_name, business_name, postal_address, timezone, sending_domain)
     values ($1, 'Jane Doe', 'Doe Design', '1 Example Street, London', 'America/Los_Angeles', 'mail.example.test')`,
    [userA],
  );
  await adminQuery(
    `insert into settings (user_id, sender_name, business_name, postal_address)
     values ($1, 'Other Person', 'Other Biz', '2 Other Road')`,
    [userB],
  );

  const client = await one<{ id: string }>(
    `insert into clients (user_id, name, email, timezone) values ($1, $2, 'billing@acme.test', 'Europe/London') returning id`,
    [userA, FORMULA_NAME],
  );
  const contact = await one<{ id: string }>(
    `insert into contacts (user_id, client_id, email, name, is_primary)
     values ($1, $2, 'billing@acme.test', 'Pat Billing', true) returning id`,
    [userA, client.id],
  );
  const sequence = await one<{ id: string }>(
    `insert into sequences (user_id, name, kind, is_default) values ($1, 'Default', 'standard', true) returning id`,
    [userA],
  );
  const step = await one<{ id: string }>(
    `insert into sequence_steps (user_id, sequence_id, position, offset_days, tone, subject, body)
     values ($1, $2, 0, -3, 'friendly', 'Quick note about invoice {invoice_number}', 'Hi {client_name}')
     returning id`,
    [userA, sequence.id],
  );

  const invoice = await one<{ id: string }>(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status, notes)
     values ($1, $2, 'INV-1042', 123450, 'USD', '2026-11-08', '2026-11-20', 'open', 'Net 12')
     returning id`,
    [userA, client.id],
  );
  await adminQuery(
    `insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'primary')`,
    [userA, invoice.id, contact.id],
  );

  const planInvoice = await one<{ id: string }>(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status)
     values ($1, $2, 'INV-1043', 100000, 'EUR', '2026-10-01', '2026-12-01', 'payment_plan') returning id`,
    [userA, client.id],
  );
  await adminQuery(
    `insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency)
     values ($1, $2, 1, '2026-12-01', 50000, 'EUR')`,
    [userA, planInvoice.id],
  );

  const scheduled = await one<{ id: string }>(
    `insert into scheduled_messages (user_id, invoice_id, step_id, contact_id, planned_at, status, dedupe_key)
     values ($1, $2, $3, $4, '2026-11-05T17:00:00Z', 'sent', $5) returning id`,
    [userA, invoice.id, step.id, contact.id, `${invoice.id}:${step.id}`],
  );
  await adminQuery(
    `insert into message_log (user_id, scheduled_message_id, invoice_id, contact_id, recipient_email, cc_emails,
       subject, body_snapshot, provider, provider_message_id, sent_at)
     values ($1, $2, $3, $4, 'billing@acme.test', $5, 'Quick note about invoice INV-1042',
       'Hi Acme, see the link https://pay.example.test/x', 'resend', 'msg_123', '2026-11-05T17:00:00Z')`,
    [userA, scheduled.id, invoice.id, contact.id, ["cc@acme.test"]],
  );
  await adminQuery(
    `insert into events (user_id, invoice_id, client_id, type, detail) values ($1, $2, $3, 'invoice.created', $4::jsonb)`,
    [userA, invoice.id, client.id, JSON.stringify({ source: "manual" })],
  );

  const ciphertext = encryptSecret(SECRET);
  await adminQuery(
    `insert into connected_accounts (user_id, provider, secret_ciphertext, account_label) values ($1, 'stripe', $2, 'Acme Stripe (test)')`,
    [userA, ciphertext],
  );
  await adminQuery(
    `insert into connected_accounts (user_id, provider, secret_ciphertext, account_label) values ($1, 'stripe', $2, 'Other Stripe')`,
    [userB, encryptSecret("rk_live_OTHER_USERS_SECRET")],
  );
  await adminQuery(`insert into stripe_events (event_id, user_id) values ('evt_test_1', $1)`, [userA]);
  await adminQuery(`insert into digests (user_id, digest_date) values ($1, '2026-11-09')`, [userA]);

  // User B has an invoice, which must not appear in A's export.
  const otherClient = await one<{ id: string }>(
    `insert into clients (user_id, name, email) values ($1, 'Other Client Ltd', 'ap@other.test') returning id`,
    [userB],
  );
  await adminQuery(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date)
     values ($1, $2, 'OTHER-999', 777, 'GBP', '2026-11-01', '2026-11-30')`,
    [userB, otherClient.id],
  );

  return { userA, userB, ciphertext };
}

function unzipAll(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]));
}

function rowsOf(csv: string): Array<Record<string, string>> {
  return parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
}

describe("exportUserData", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns a zip with exactly one CSV per user table", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    expect(Object.keys(files).sort()).toEqual(EXPECTED_FILES);
  });

  it("contains only the requesting user's rows, enforced by row-level security", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));

    expect(rowsOf(files["invoices.csv"]).map((r) => r.invoice_number).sort()).toEqual(["INV-1042", "INV-1043"]);
    expect(rowsOf(files["users.csv"]).map((r) => r.email)).toEqual(["owner-a@example.test"]);

    for (const content of Object.values(files)) {
      expect(content).not.toContain("OTHER-999");
      expect(content).not.toContain("owner-b@example.test");
      expect(content).not.toContain("Other Person");
      expect(content).not.toContain("Other Client Ltd");
      expect(content).not.toContain("OTHER_USERS_SECRET");
    }
  });

  it("never includes connected-account secrets, in any form", async () => {
    const { userA, ciphertext } = await seed();
    const files = unzipAll(await exportUserData(userA));

    for (const content of Object.values(files)) {
      expect(content).not.toContain(SECRET);
      expect(content).not.toContain("TESTSECRETVALUE");
      expect(content).not.toContain(ciphertext);
    }
    const accounts = files["connected_accounts.csv"].split("\r\n")[0];
    expect(accounts).toBe("id,user_id,provider,account_label,created_at");
    const [account] = rowsOf(files["connected_accounts.csv"]);
    expect(account.provider).toBe("stripe");
    expect(account.account_label).toBe("Acme Stripe (test)");
  });

  it("escapes formula-like cells with an apostrophe and quotes them correctly", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    const [client] = rowsOf(files["clients.csv"]);
    expect(client.name).toBe(`'${FORMULA_NAME}`);
  });

  it("keeps calendar dates as written, even in a time zone behind UTC", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    const invoices = rowsOf(files["invoices.csv"]);
    const first = invoices.find((r) => r.invoice_number === "INV-1042");
    expect(first?.issue_date).toBe("2026-11-08");
    expect(first?.due_date).toBe("2026-11-20");
    expect(rowsOf(files["payment_plan_installments.csv"])[0].due_date).toBe("2026-12-01");
    expect(rowsOf(files["digests.csv"])[0].digest_date).toBe("2026-11-09");
  });

  it("exports money as integer minor units beside its currency", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    const invoice = rowsOf(files["invoices.csv"]).find((r) => r.invoice_number === "INV-1042");
    expect(invoice?.amount_minor).toBe("123450");
    expect(invoice?.currency).toBe("USD");
    expect(rowsOf(files["payment_plan_installments.csv"])[0].amount_minor).toBe("50000");
  });

  it("exports timestamps as UTC ISO strings", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    const sentAt = rowsOf(files["message_log.csv"])[0].sent_at;
    expect(sentAt).toBe("2026-11-05T17:00:00.000Z");
    expect(rowsOf(files["invoices.csv"])[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("exports JSON for jsonb and array columns", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    expect(JSON.parse(rowsOf(files["events.csv"])[0].detail)).toEqual({ source: "manual" });
    expect(JSON.parse(rowsOf(files["message_log.csv"])[0].cc_emails)).toEqual(["cc@acme.test"]);
  });

  it("includes message bodies, events and delivery records, the user's data the spec requires", async () => {
    const { userA } = await seed();
    const files = unzipAll(await exportUserData(userA));
    expect(rowsOf(files["message_log.csv"])[0].body_snapshot).toBe("Hi Acme, see the link https://pay.example.test/x");
    expect(rowsOf(files["message_log.csv"])[0].provider_message_id).toBe("msg_123");
    expect(rowsOf(files["events.csv"])[0].type).toBe("invoice.created");
    expect(rowsOf(files["scheduled_messages.csv"])[0].status).toBe("sent");
  });

  it("gives a user with no activity a header-only file for each table, plus their own user row", async () => {
    const userC = await createUser("quiet@example.test");
    const files = unzipAll(await exportUserData(userC));
    expect(Object.keys(files).sort()).toEqual(EXPECTED_FILES);
    expect(rowsOf(files["users.csv"]).map((r) => r.email)).toEqual(["quiet@example.test"]);
    expect(rowsOf(files["invoices.csv"])).toEqual([]);
    expect(files["invoices.csv"].split("\r\n")[0]).toContain("invoice_number");
  });

  it("rejects a value that is not a user id", async () => {
    await expect(exportUserData("not-a-uuid")).rejects.toThrow(TypeError);
  });
});
