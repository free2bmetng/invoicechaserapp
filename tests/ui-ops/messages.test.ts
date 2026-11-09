// Message log: keyset pagination at 50 rows, filters, and tenant isolation. The rows are
// real sends from the sender, so every message_log row has a provider reference.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import {
  countMessageLogByStatus,
  listClientOptions,
  listMessageLog,
  MESSAGE_LOG_PAGE_SIZE,
  MESSAGE_SEARCH_MAX_LENGTH,
  parseMessageLogFilters,
  type MessageLogPage,
} from "@/lib/queries/messages";
import { adminQuery } from "../helpers/db";
import { newClient, newInvoice, newUser, resetDb, runSendWindow } from "./fixtures";

const SENT_COUNT = 55;

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

// One client with 55 invoices that each send at the first run. Returns the owner and client.
async function sentMessages(): Promise<{ userId: string; clientId: string; email: string }> {
  // The cap is raised so every reminder in the run is allowed to go out.
  const userId = await newUser({ dailyCap: 100 });
  const client = await newClient(userId, { name: "Acme Ltd", autoSend: true });
  for (let i = 1; i <= SENT_COUNT; i += 1) {
    await newInvoice(userId, client.clientId, { number: `MSG-${String(i).padStart(3, "0")}`, due: "2030-01-10" });
  }
  const { result } = await runSendWindow();
  if (result.sent !== SENT_COUNT) throw new Error(`expected ${SENT_COUNT} sends, got ${result.sent}`);
  return { userId, clientId: client.clientId, email: client.email };
}

async function page(
  userId: string,
  params: { status?: string; client?: string; cursor?: string; q?: string } = {},
): Promise<MessageLogPage> {
  return listMessageLog(userId, parseMessageLogFilters(params));
}

describe("listMessageLog pagination", () => {
  it("returns newest first, 50 per page, and reaches every row exactly once", async () => {
    const { userId } = await sentMessages();

    const first = await page(userId);
    expect(first.rows).toHaveLength(MESSAGE_LOG_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();

    const second = await page(userId, { cursor: first.nextCursor ?? undefined });
    expect(second.rows).toHaveLength(SENT_COUNT - MESSAGE_LOG_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(SENT_COUNT);

    const times = [...first.rows, ...second.rows].map((r) => Date.parse(r.sentAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("does not skip or repeat rows that share a timestamp across a page boundary", async () => {
    const { userId } = await sentMessages();
    // Every row gets the same sent_at, down to the microsecond, so only the id orders them.
    await adminQuery("update message_log set sent_at = '2030-01-10 10:00:00.123456+00' where user_id = $1", [userId]);

    const first = await page(userId);
    const second = await page(userId, { cursor: first.nextCursor ?? undefined });
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(SENT_COUNT);
    expect(second.rows).toHaveLength(SENT_COUNT - MESSAGE_LOG_PAGE_SIZE);
  });

  it("carries the recipient, subject, status, the exact body and the client for each row", async () => {
    const { userId, email } = await sentMessages();
    const [row] = (await page(userId)).rows;
    expect(row.recipientEmail).toBe(email);
    expect(row.subject.length).toBeGreaterThan(0);
    expect(row.bodySnapshot).toContain("Okafor Studio");
    expect(row.deliveryStatus).toBe("sent");
    expect(row.clientName).toBe("Acme Ltd");
    expect(row.invoiceNumber).toMatch(/^MSG-\d{3}$/);
    expect(row.providerMessageId).toMatch(/^fake_/);
    expect(row.manual).toBe(false);
  });
});

describe("listMessageLog filters", () => {
  it("filters by delivery status", async () => {
    const { userId } = await sentMessages();
    expect((await page(userId, { status: "sent" })).rows).toHaveLength(MESSAGE_LOG_PAGE_SIZE);
    expect((await page(userId, { status: "bounced" })).rows).toHaveLength(0);
  });

  it("filters by client, and treats an unknown client id as no match", async () => {
    const { userId, clientId } = await sentMessages();
    const other = await newClient(userId, { name: "Empty Co" });

    expect((await page(userId, { client: clientId })).rows.length).toBeGreaterThan(0);
    expect((await page(userId, { client: other.clientId })).rows).toHaveLength(0);
    expect((await page(userId, { client: "00000000-0000-4000-8000-000000000000" })).rows).toHaveLength(0);
  });

  it("drops an unknown status instead of passing it to the query", async () => {
    const { userId } = await sentMessages();
    expect((await page(userId, { status: "delivered; drop table x" })).rows).toHaveLength(MESSAGE_LOG_PAGE_SIZE);
  });
});

describe("message log tenant isolation", () => {
  it("never returns another user's messages, or their clients in the filter menu", async () => {
    const { clientId } = await sentMessages();
    const other = await newUser();

    expect((await page(other)).rows).toHaveLength(0);
    expect((await page(other, { client: clientId })).rows).toHaveLength(0);
    expect(await listClientOptions(other)).toEqual([]);
  });

  it("lists the owner's clients by name for the filter menu", async () => {
    const { userId } = await sentMessages();
    const names = (await listClientOptions(userId)).map((c) => c.name);
    expect(names).toContain("Acme Ltd");
  });
});

describe("message log search, status counts and amounts", () => {
  it("parses the search and the selected message, and drops them when empty or malformed", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(parseMessageLogFilters({ q: "  acme   ltd ", id })).toEqual({ status: null, clientId: null, cursor: null, q: "acme ltd", selectedId: id });
    const empty = parseMessageLogFilters({ q: "   ", id: "x" });
    expect(empty.q).toBeUndefined();
    expect(empty.selectedId).toBeUndefined();
    expect(parseMessageLogFilters({ q: "a".repeat(500) }).q).toHaveLength(MESSAGE_SEARCH_MAX_LENGTH);
  });

  it("searches the client, invoice number, recipient and subject, case-insensitively", async () => {
    const { userId, email } = await sentMessages();
    expect((await page(userId, { q: "acme" })).rows).toHaveLength(MESSAGE_LOG_PAGE_SIZE);
    const byNumber = await page(userId, { q: "msg-007" });
    expect(byNumber.rows.map((r) => r.invoiceNumber)).toEqual(["MSG-007"]);
    expect((await page(userId, { q: email.toUpperCase() })).rows.length).toBeGreaterThan(0);
    expect((await page(userId, { q: "no such thing" })).rows).toHaveLength(0);
  });

  it("matches LIKE wildcards literally", async () => {
    const { userId } = await sentMessages();
    expect((await page(userId, { q: "%" })).rows).toHaveLength(0);
    expect((await page(userId, { q: "MSG_00" })).rows).toHaveLength(0);
  });

  it("combines search with the status and client filters, and counts each status within them", async () => {
    const { userId, clientId } = await sentMessages();
    await adminQuery(
      "update message_log m set delivery_status = 'bounced' from invoices i where i.id = m.invoice_id and i.invoice_number in ('MSG-001', 'MSG-002')",
    );
    expect((await page(userId, { q: "msg-00", status: "bounced" })).rows.map((r) => r.invoiceNumber).sort()).toEqual(["MSG-001", "MSG-002"]);

    const counts = await countMessageLogByStatus(userId, parseMessageLogFilters({ client: clientId }));
    expect(counts).toEqual({ all: SENT_COUNT, sent: SENT_COUNT - 2, delivered: 0, bounced: 2, failed: 0 });
    const searched = await countMessageLogByStatus(userId, parseMessageLogFilters({ q: "MSG-001" }));
    expect(searched).toEqual({ all: 1, sent: 0, delivered: 0, bounced: 1, failed: 0 });
    expect(await countMessageLogByStatus(await newUser(), { clientId: null })).toEqual({ all: 0, sent: 0, delivered: 0, bounced: 0, failed: 0 });
  });

  it("carries the amount chased and the invoice id for each row", async () => {
    const { userId } = await sentMessages();
    const [row] = (await page(userId)).rows;
    expect(row.amountMinor).toBe(10000);
    expect(row.currency).toBe("USD");
    expect(row.invoiceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
