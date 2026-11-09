// Read helpers for the UI: invoice and client lists, invoice detail with its message
// timeline, and client detail. Amounts stay per currency, and reads are user-scoped.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  getClientDetail,
  getInvoiceDetail,
  listClients,
  listInvoices,
  listSequences,
  NotFoundError,
  recordPayment,
  recordReply,
  runSender,
  setInvoiceStatus,
  upsertContact,
} from "@/lib/engine";
import { NOW, addClient, addInvoice, clockAt, depsFor, planAt, setupUser } from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("listInvoices", () => {
  it("filters by status, client and search, and reports the next planned time", async () => {
    const owner = await setupUser();
    const acme = await addClient(owner.userId, { name: "Acme Ltd", autoSend: true, timezone: "UTC" });
    const globex = await addClient(owner.userId, { name: "Globex", autoSend: true, timezone: "UTC" });
    const a = await addInvoice(owner.userId, acme.clientId, { number: "INV-A", due: "2026-11-20" });
    const g = await addInvoice(owner.userId, globex.clientId, { number: "INV-G", due: "2026-11-20", status: "paused" });
    await planAt(owner.userId, a);

    const all = await listInvoices(owner.userId);
    expect(all.map((i) => i.invoiceNumber).sort()).toEqual(["INV-A", "INV-G"]);
    const invoiceA = all.find((i) => i.id === a)!;
    expect(invoiceA.nextPlannedAt && new Date(invoiceA.nextPlannedAt).toISOString()).toBe("2026-11-17T09:00:00.000Z");
    expect((await listInvoices(owner.userId, { status: "paused" })).map((i) => i.id)).toEqual([g]);
    expect((await listInvoices(owner.userId, { clientId: acme.clientId })).map((i) => i.id)).toEqual([a]);
    expect((await listInvoices(owner.userId, { search: "globex" })).map((i) => i.id)).toEqual([g]);
    expect((await listInvoices(owner.userId, { search: "inv-a" })).map((i) => i.id)).toEqual([a]);
  });

  it("returns only the caller's invoices", async () => {
    const owner = await setupUser();
    const other = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true });
    await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    expect(await listInvoices(other.userId)).toHaveLength(0);
  });
});

describe("listClients", () => {
  it("keeps outstanding and overdue amounts per currency and never adds across currencies", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true, timezone: "UTC" });
    await addInvoice(owner.userId, client.clientId, { number: "U1", amountMinor: 10000, currency: "USD", due: "2026-11-01" });
    await addInvoice(owner.userId, client.clientId, { number: "U2", amountMinor: 5000, currency: "EUR", due: "2026-12-01" });
    await addInvoice(owner.userId, client.clientId, { number: "U3", amountMinor: 999, currency: "USD", due: "2026-11-01", status: "paid" });
    const [row] = (await listClients(owner.userId, clockAt(NOW))).filter((c) => c.id === client.clientId);
    expect(row.outstanding.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: "EUR", amountMinor: 5000 },
      { currency: "USD", amountMinor: 10000 },
    ]);
    expect(row.overdue).toEqual([{ currency: "USD", amountMinor: 10000 }]);
    expect(row.averageDaysToPay).toBeNull();
  });

  it("computes average days to pay from issue date to paid date, and the last contact", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true, timezone: "UTC" });
    const paidInvoice = await addInvoice(owner.userId, client.clientId, { number: "P1", issue: "2026-10-01", due: "2026-11-10", status: "open" });
    await planAt(owner.userId, paidInvoice);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-10T12:00:00Z"), email));
    await recordPayment({ userId: owner.userId, invoiceId: paidInvoice, installmentId: null, paidAt: new Date("2026-10-31T10:00:00Z"), source: "manual", clock: clockAt("2026-10-31T10:00:00Z") });
    const [row] = (await listClients(owner.userId, clockAt(NOW))).filter((c) => c.id === client.clientId);
    expect(row.averageDaysToPay).toBe(30);
    // The reminder was sent at the fixed clock, so that is the last contact.
    expect(email.calls).toHaveLength(1);
    expect(row.lastContactAt && new Date(row.lastContactAt).toISOString()).toBe(NOW);
  });

  it("reports the number of contacts and the reply hold", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true, timezone: "UTC" });
    await upsertContact(owner.userId, client.clientId, { email: "ap@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    await recordReply({ userId: owner.userId, clientId: client.clientId, clock: clockAt(NOW) });
    const [row] = (await listClients(owner.userId, clockAt(NOW))).filter((c) => c.id === client.clientId);
    expect(row.contactCount).toBe(2);
    expect(row.replyHeldAt).not.toBeNull();
  });
});

describe("getInvoiceDetail", () => {
  it("returns the message timeline with send records, contacts and the event timeline", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true, timezone: "UTC" });
    const cc = await upsertContact(owner.userId, client.clientId, { email: "cc@acme.example.test", name: "CC", isPrimary: false }, clockAt(NOW));
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    await adminQuery("insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'cc')", [owner.userId, invoiceId, cc.contactId]);
    await planAt(owner.userId, invoiceId);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));

    const detail = await getInvoiceDetail(owner.userId, invoiceId);
    expect(detail.contacts.primary?.email).toBe(client.email);
    expect(detail.contacts.cc.map((c) => c.email)).toEqual(["cc@acme.example.test"]);
    expect(detail.messages).toHaveLength(4);
    const sent = detail.messages.filter((m) => m.sent !== null);
    expect(sent).toHaveLength(1);
    expect(sent[0].sent?.providerMessageId).toMatch(/^fake_/);
    expect(sent[0].sent?.bodySnapshot).toContain("Ada Studio");
    expect(sent[0].sent?.manual).toBe(false);
    expect(detail.messages.some((m) => m.status === "skipped")).toBe(true);
    expect(detail.events.some((e) => e.type === "message_sent")).toBe(true);
    expect(detail.events.some((e) => e.type === "send_attempt")).toBe(false);
    // Nothing in the detail carries a payment link or a provider credential.
    expect(JSON.stringify(detail)).not.toMatch(/stripe_payment_link|sk_|rk_/);
  });

  it("shows status changes in the timeline, newest first", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await setInvoiceStatus(owner.userId, invoiceId, "paused", clockAt(NOW));
    await setInvoiceStatus(owner.userId, invoiceId, "open", clockAt(NOW));
    const detail = await getInvoiceDetail(owner.userId, invoiceId);
    const statusEvents = detail.events.filter((e) => e.type === "status_changed");
    expect(statusEvents.map((e) => e.detail.to)).toEqual(["open", "paused"]);
  });

  it("refuses an invoice owned by another user", async () => {
    const owner = await setupUser();
    const other = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await expect(getInvoiceDetail(other.userId, invoiceId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getClientDetail and listSequences", () => {
  it("lists contacts with the primary first, and refuses another user's client", async () => {
    const owner = await setupUser();
    const other = await setupUser();
    const client = await addClient(owner.userId, { name: "Acme", autoSend: true });
    await upsertContact(owner.userId, client.clientId, { email: "a@acme.example.test", name: "A", isPrimary: false }, clockAt(NOW));
    const detail = await getClientDetail(owner.userId, client.clientId);
    expect(detail.contacts[0].isPrimary).toBe(true);
    expect(detail.contacts).toHaveLength(2);
    await expect(getClientDetail(other.userId, client.clientId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists sequences with their steps in send order", async () => {
    const owner = await setupUser();
    const sequences = await listSequences(owner.userId);
    const standard = sequences.find((s) => s.kind === "standard" && s.isDefault)!;
    expect(standard.steps.map((s) => s.offsetDays)).toEqual([-3, 0, 7, 14]);
    expect(sequences.some((s) => s.kind === "plan" && s.isDefault)).toBe(true);
  });
});
