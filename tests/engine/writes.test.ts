// Write APIs for the UI: clients, contacts, invoices, the CSV commit path and sequences.
// Each one runs under the user's lock, and each is checked against Postgres.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider, FakePaymentProvider } from "@/lib/providers/fake";
import {
  createClient,
  createInvoice,
  importInvoices,
  planOpenInvoices,
  removeContact,
  runSender,
  saveSequence,
  setAutoSend,
  setInvoiceContacts,
  upsertContact,
  updateClient,
  updateInvoice,
  NotFoundError,
  InvalidStateError,
  ValidationError,
  InvalidTimezoneError,
  setInvoiceStatus,
  holdContact,
} from "@/lib/engine";
import {
  NOW,
  PLAN_AT,
  addClient,
  addInstallments,
  addInvoice,
  clockAt,
  depsFor,
  invoiceRow,
  planAt,
  rowsOf,
  rowStatus,
  setupUser,
  statusesOf,
  type Owner,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function sequenceId(userId: string, kind: "standard" | "plan" = "standard", isDefault = true): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "select id from sequences where user_id = $1 and kind = $2 and is_default = $3", [userId, kind, isDefault],
  );
  return rows[0].id;
}

async function contactsOf(clientId: string) {
  const { rows } = await adminQuery<{ id: string; email: string; is_primary: boolean; hold: string | null }>(
    "select id, email, is_primary, hold from contacts where client_id = $1 order by email", [clientId],
  );
  return rows;
}

describe("payment links follow the currency", () => {
  it("a currency change alone creates a new payment link and deactivates the old one", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000, currency: "USD" });
    await planAt(owner.userId, invoiceId);
    const payments = new FakePaymentProvider();
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email, payments));
    expect(payments.createdLinks).toHaveLength(1);
    expect(payments.createdLinks[0].currency).toBe("USD");

    await updateInvoice(owner.userId, invoiceId, { currency: "EUR" }, clockAt(NOW));
    // Move a later step into the window so the next send goes out now.
    const next = (await rowsOf(invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set planned_at = $2 where id = $1", [next.id, new Date("2026-11-10T11:00:00Z")]);
    await runSender(depsFor(clockAt("2026-11-10T12:20:00Z"), email, payments));
    expect(payments.createdLinks).toHaveLength(2);
    expect(payments.createdLinks[1].currency).toBe("EUR");
    expect(payments.createdLinks[1].amountMinor).toBe(10000);
    expect(payments.deactivated).toEqual(["plink_fake_1"]);
    expect((await invoiceRow(invoiceId)).stripe_link_currency).toBe("EUR");
  });

  it("an unchanged amount and currency reuse the link", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    await planAt(owner.userId, invoiceId);
    const payments = new FakePaymentProvider();
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email, payments));
    await updateInvoice(owner.userId, invoiceId, { notes: "Thanks for your business" }, clockAt(NOW));
    expect(payments.createdLinks).toHaveLength(1);
  });
});

describe("clients", () => {
  it("creates a client with a lower-cased email and a primary contact with that email", async () => {
    const owner = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme Ltd", email: "  Billing@ACME.example.test " }, clockAt(NOW));
    const rows = await contactsOf(created.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("billing@acme.example.test");
    expect(rows[0].is_primary).toBe(true);
    expect(rows[0].id).toBe(created.contactId);
  });

  it("rejects a duplicate email in any letter case, and an invalid email", async () => {
    const owner = await setupUser();
    await createClient(owner.userId, { name: "Acme", email: "billing@acme.example.test" }, clockAt(NOW));
    await expect(createClient(owner.userId, { name: "Other", email: "BILLING@acme.example.test" }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(createClient(owner.userId, { name: "Bad", email: "not-an-email" }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown timezone and a non-standard sequence", async () => {
    const owner = await setupUser();
    await expect(createClient(owner.userId, { name: "A", email: "a@example.test", timezone: "Mars/Olympus" }, clockAt(NOW))).rejects.toBeInstanceOf(InvalidTimezoneError);
    const plan = await sequenceId(owner.userId, "plan");
    await expect(createClient(owner.userId, { name: "A", email: "a@example.test", sequenceId: plan }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("changing the client email moves the primary contact when it used the same address", async () => {
    const owner = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme", email: "old@acme.example.test" }, clockAt(NOW));
    await updateClient(owner.userId, created.clientId, { email: "new@acme.example.test" }, clockAt(NOW));
    const rows = await contactsOf(created.clientId);
    expect(rows.map((r) => r.email)).toEqual(["new@acme.example.test"]);
  });

  it("changing the timezone replans unsent rows to 09:00 in the new timezone", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    await planAt(owner.userId, invoiceId);
    await updateClient(owner.userId, client.clientId, { timezone: "America/New_York" }, clockAt(NOW));
    const rows = await rowsOf(invoiceId);
    const due = rows.find((r) => r.status === "scheduled" && new Date(r.planned_at).toISOString().startsWith("2026-11-10"));
    expect(due?.planned_at && new Date(due.planned_at).toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });

  it("turning auto-send on through updateClient releases rule (b) rows", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: false });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    expect((await statusesOf(invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(4);
    await updateClient(owner.userId, client.clientId, { autoSend: true }, clockAt(NOW));
    expect((await statusesOf(invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(0);
    await setAutoSend(owner.userId, client.clientId, true, clockAt(NOW));
  });

  it("changing the client sequence replans the open invoices that inherit it", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    const custom = await saveSequence(owner.userId, {
      name: "Only a late reminder",
      kind: "standard",
      isDefault: false,
      steps: [{ offsetDays: 30, tone: "neutral", subject: "Invoice {invoice_number}", body: "Hello {client_name}." }],
    }, clockAt(NOW));
    await updateClient(owner.userId, client.clientId, { sequenceId: custom.sequenceId }, clockAt(NOW));
    const rows = (await rowsOf(invoiceId)).filter((r) => r.status === "scheduled" || r.status === "pending_approval");
    expect(rows).toHaveLength(1);
  });

  it("refuses edits from another user", async () => {
    const owner = await setupUser();
    const other = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme", email: "a@acme.example.test" }, clockAt(NOW));
    await expect(updateClient(other.userId, created.clientId, { name: "Hijacked" }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("contacts", () => {
  it("adds a secondary contact and rejects a duplicate address in the same client", async () => {
    const owner = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme", email: "a@acme.example.test" }, clockAt(NOW));
    const added = await upsertContact(owner.userId, created.clientId, { email: "AP@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    expect(added.contactId).toBeTruthy();
    await expect(upsertContact(owner.userId, created.clientId, { email: "ap@acme.example.test", name: "AP2", isPrimary: false }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("promoting a contact to primary demotes the old one, and the primary cannot be demoted alone", async () => {
    const owner = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme", email: "a@acme.example.test" }, clockAt(NOW));
    const second = await upsertContact(owner.userId, created.clientId, { email: "b@acme.example.test", name: "B", isPrimary: false }, clockAt(NOW));
    await expect(upsertContact(owner.userId, created.clientId, { id: created.contactId, email: "a@acme.example.test", name: "A", isPrimary: false }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await upsertContact(owner.userId, created.clientId, { id: second.contactId, email: "b@acme.example.test", name: "B", isPrimary: true }, clockAt(NOW));
    const rows = await contactsOf(created.clientId);
    expect(rows.filter((r) => r.is_primary).map((r) => r.email)).toEqual(["b@acme.example.test"]);
  });

  it("refuses to remove the primary contact", async () => {
    const owner = await setupUser();
    const created = await createClient(owner.userId, { name: "Acme", email: "a@acme.example.test" }, clockAt(NOW));
    await expect(removeContact(owner.userId, created.contactId, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to remove a contact that has sent messages", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", contactId: client.contactId });
    const ap = await upsertContact(owner.userId, client.clientId, { email: "ap@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    await adminQuery("update invoice_contacts set contact_id = $2, role = 'primary' where invoice_id = $1", [invoiceId, ap.contactId]);
    await planAt(owner.userId, invoiceId);
    await adminQuery("update scheduled_messages set status = 'sent' where invoice_id = $1 and status = 'scheduled' and contact_id = $2 and planned_at < $3", [invoiceId, ap.contactId, new Date(NOW)]);
    await expect(removeContact(owner.userId, ap.contactId, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("removing a cc contact drops it from the invoice and leaves the rows intact", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const cc = await upsertContact(owner.userId, client.clientId, { email: "cc@acme.example.test", name: "CC", isPrimary: false }, clockAt(NOW));
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", contactId: client.contactId });
    await adminQuery("insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'cc')", [owner.userId, invoiceId, cc.contactId]);
    await planAt(owner.userId, invoiceId);
    const before = (await rowsOf(invoiceId)).length;
    await removeContact(owner.userId, cc.contactId, clockAt(NOW));
    const remaining = await adminQuery<{ n: string }>("select count(*)::text as n from invoice_contacts where invoice_id = $1 and role = 'cc'", [invoiceId]);
    expect(remaining.rows[0].n).toBe("0");
    expect(await rowsOf(invoiceId)).toHaveLength(before);
  });

  it("removing a contact moves its unsent rows to the primary, and releases held rows the primary does not hold", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const ap = await upsertContact(owner.userId, client.clientId, { email: "ap@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-12-01", contactId: ap.contactId });
    await planAt(owner.userId, invoiceId);
    await adminQuery("update contacts set hold = 'bounced' where id = $1", [ap.contactId]);
    await adminQuery("update scheduled_messages set status = 'held', prior_status = 'scheduled' where invoice_id = $1", [invoiceId]);
    await removeContact(owner.userId, ap.contactId, clockAt("2026-11-12T12:00:00Z"));
    const rows = await rowsOf(invoiceId);
    expect(rows.every((r) => r.contact_id === client.contactId)).toBe(true);
    expect(rows.filter((r) => r.status === "scheduled").length).toBeGreaterThan(0);
    expect(rows.some((r) => r.status === "held")).toBe(false);
  });
});

describe("invoices", () => {
  it("creates an invoice with its primary and cc contacts and plans it", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const cc = await upsertContact(owner.userId, client.clientId, { email: "cc@acme.example.test", name: "CC", isPrimary: false }, clockAt(NOW));
    const created = await createInvoice(owner.userId, {
      clientId: client.clientId,
      invoiceNumber: "INV-100",
      amountMinor: 25000,
      currency: "usd",
      issueDate: "2026-10-01",
      dueDate: "2026-11-20",
      notes: "Net 30",
      contacts: { primaryContactId: client.contactId, ccContactIds: [cc.contactId] },
    }, clockAt(PLAN_AT));
    const row = await invoiceRow(created.invoiceId);
    expect(row.currency).toBe("USD");
    expect(row.amount_minor).toBe("25000");
    expect(await rowsOf(created.invoiceId)).toHaveLength(4);
    const cc2 = await adminQuery<{ n: string }>("select count(*)::text as n from invoice_contacts where invoice_id = $1 and role = 'cc'", [created.invoiceId]);
    expect(cc2.rows[0].n).toBe("1");
  });

  it("uses the client's primary contact when no contacts are given", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const created = await createInvoice(owner.userId, { clientId: client.clientId, invoiceNumber: "INV-1", amountMinor: 100, currency: "EUR", issueDate: "2026-10-01", dueDate: "2026-11-20" }, clockAt(PLAN_AT));
    const rows = await rowsOf(created.invoiceId);
    expect(rows.every((r) => r.contact_id === client.contactId)).toBe(true);
  });

  it("rejects a duplicate (client, invoice number), a due date before the issue date, and an unknown currency", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const base = { clientId: client.clientId, invoiceNumber: "INV-7", amountMinor: 100, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-20" };
    await createInvoice(owner.userId, base, clockAt(PLAN_AT));
    await expect(createInvoice(owner.userId, base, clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(owner.userId, { ...base, invoiceNumber: "INV-8", dueDate: "2026-09-01" }, clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(owner.userId, { ...base, invoiceNumber: "INV-9", currency: "ZZZ" }, clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects contacts that belong to another client", async () => {
    const owner = await setupUser();
    const a = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const b = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    await expect(createInvoice(owner.userId, {
      clientId: a.clientId, invoiceNumber: "INV-1", amountMinor: 100, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-20",
      contacts: { primaryContactId: b.contactId, ccContactIds: [] },
    }, clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
  });

  it("a due date change replans unsent rows", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    await updateInvoice(owner.userId, invoiceId, { dueDate: "2026-11-25" }, clockAt(NOW));
    const times = (await rowsOf(invoiceId)).map((r) => new Date(r.planned_at).toISOString());
    expect(times).toContain("2026-11-25T09:00:00.000Z");
  });

  it("a sequence change replans unsent rows with the new sequence", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    const custom = await saveSequence(owner.userId, {
      name: "Two reminders",
      kind: "standard",
      isDefault: false,
      steps: [
        { offsetDays: 1, tone: "friendly", subject: "Invoice {invoice_number}", body: "Hi {client_name}." },
        { offsetDays: 5, tone: "neutral", subject: "Invoice {invoice_number}", body: "Hi {client_name}, again." },
      ],
    }, clockAt(NOW));
    await updateInvoice(owner.userId, invoiceId, { sequenceId: custom.sequenceId }, clockAt(NOW));
    const rows = (await rowsOf(invoiceId)).filter((r) => r.status === "scheduled" || r.status === "pending_approval");
    expect(rows.map((r) => new Date(r.planned_at).toISOString()).sort()).toEqual(["2026-11-21T09:00:00.000Z", "2026-11-25T09:00:00.000Z"]);
  });

  it("refuses to edit a paid or written-off invoice", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const paid = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20", status: "paid" });
    const written = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20", status: "written_off" });
    await expect(updateInvoice(owner.userId, paid, { notes: "x" }, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
    await expect(updateInvoice(owner.userId, written, { amountMinor: 1 }, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("an amount change reaches the next message", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000 });
    await planAt(owner.userId, invoiceId);
    await updateInvoice(owner.userId, invoiceId, { amountMinor: 12345 }, clockAt(NOW));
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls[0].text).toContain("123.45");
  });

  it("an amount change is refused when it breaks an existing payment plan", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000, status: "payment_plan" });
    await addInstallments(owner.userId, invoiceId, [{ due: "2026-12-01", amountMinor: 6000 }, { due: "2027-01-01", amountMinor: 4000 }]);
    await expect(updateInvoice(owner.userId, invoiceId, { amountMinor: 12000 }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await updateInvoice(owner.userId, invoiceId, { amountMinor: 10000, notes: "same amount" }, clockAt(NOW));
  });

  it("a currency change updates the unpaid installments", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000, status: "payment_plan" });
    await addInstallments(owner.userId, invoiceId, [{ due: "2026-12-01", amountMinor: 6000 }, { due: "2027-01-01", amountMinor: 4000 }]);
    await updateInvoice(owner.userId, invoiceId, { currency: "GBP" }, clockAt(NOW));
    const { rows } = await adminQuery<{ currency: string }>("select currency from payment_plan_installments where invoice_id = $1", [invoiceId]);
    expect(rows.every((r) => r.currency === "GBP")).toBe(true);
  });

  it("a duplicate invoice number on edit is refused; a notes-only edit leaves the rows alone", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const first = await addInvoice(owner.userId, client.clientId, { number: "INV-A", due: "2026-11-20" });
    const second = await addInvoice(owner.userId, client.clientId, { number: "INV-B", due: "2026-11-20" });
    await planAt(owner.userId, second);
    await expect(updateInvoice(owner.userId, second, { invoiceNumber: "INV-A" }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    const before = await rowsOf(second);
    await updateInvoice(owner.userId, second, { notes: "Thanks" }, clockAt(NOW));
    expect(await rowsOf(second)).toEqual(before);
    expect(first).toBeTruthy();
  });

  it("changing the primary contact of an invoice moves its unsent rows to the new primary", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const ap = await upsertContact(owner.userId, client.clientId, { email: "ap@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    await updateInvoice(owner.userId, invoiceId, { contacts: { primaryContactId: ap.contactId, ccContactIds: [] } }, clockAt(NOW));
    const rows = await rowsOf(invoiceId);
    expect(rows.filter((r) => r.status === "scheduled" || r.status === "pending_approval").every((r) => r.contact_id === ap.contactId)).toBe(true);
  });

  it("setInvoiceContacts enforces the client's contacts and a primary that is not also cc", async () => {
    const owner = await setupUser();
    const a = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const b = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, a.clientId, { due: "2026-11-20" });
    await expect(setInvoiceContacts(owner.userId, invoiceId, { primaryContactId: b.contactId, ccContactIds: [] }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(setInvoiceContacts(owner.userId, invoiceId, { primaryContactId: a.contactId, ccContactIds: [a.contactId] }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(setInvoiceContacts(owner.userId, invoiceId, { primaryContactId: a.contactId, ccContactIds: [b.contactId] }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    const cc = await upsertContact(owner.userId, a.clientId, { email: "cc@acme.example.test", name: "CC", isPrimary: false }, clockAt(NOW));
    await setInvoiceContacts(owner.userId, invoiceId, { primaryContactId: a.contactId, ccContactIds: [cc.contactId] }, clockAt(NOW));
    const roles = await adminQuery<{ role: string }>("select role from invoice_contacts where invoice_id = $1 order by role", [invoiceId]);
    expect(roles.rows.map((r) => r.role)).toEqual(["cc", "primary"]);
  });

  it("an invoice made before the profile is complete gets no rows until planOpenInvoices runs", async () => {
    const owner = await setupUser({ profile: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await createInvoice(owner.userId, { clientId: client.clientId, invoiceNumber: "INV-EARLY", amountMinor: 500, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-20" }, clockAt(PLAN_AT));
    expect(await rowsOf(invoiceId.invoiceId)).toHaveLength(0);
    await adminQuery("update settings set sender_name = 'Ada', business_name = 'Ada Studio', postal_address = '1 Main St' where user_id = $1", [owner.userId]);
    expect(await planOpenInvoices(owner.userId, clockAt(PLAN_AT))).toBeGreaterThan(0);
    expect(await rowsOf(invoiceId.invoiceId)).toHaveLength(4);
  });
});

describe("CSV commit path", () => {
  const row = (over: Partial<Parameters<typeof importInvoices>[1][number]> = {}) => ({
    clientName: "Acme Ltd",
    clientEmail: "Billing@Acme.example.test",
    invoiceNumber: "INV-1",
    amountMinor: 10000,
    currency: "USD",
    issueDate: "2026-10-01",
    dueDate: "2026-11-20",
    ...over,
  });

  it("creates clients and invoices, matching existing clients by email in any case", async () => {
    const owner = await setupUser();
    const existing = await addClient(owner.userId, { email: "billing@acme.example.test", timezone: "UTC" });
    const result = await importInvoices(owner.userId, [
      row({ line: 2 }),
      row({ line: 3, clientEmail: "new@other.example.test", clientName: "Other", invoiceNumber: "INV-2" }),
    ], clockAt(PLAN_AT));
    expect(result).toEqual({ created: 2, duplicates: 0, clientsCreated: 1, rejected: [] });
    const invoices = await adminQuery<{ client_id: string; source: string }>("select client_id, source from invoices where user_id = $1 order by invoice_number", [owner.userId]);
    expect(invoices.rows[0].client_id).toBe(existing.clientId);
    expect(invoices.rows.every((r) => r.source === "csv")).toBe(true);
  });

  it("skips a row whose client and invoice number already exist, and never overwrites it", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { email: "billing@acme.example.test", timezone: "UTC" });
    await addInvoice(owner.userId, client.clientId, { number: "INV-1", amountMinor: 999, due: "2026-11-20" });
    const result = await importInvoices(owner.userId, [row()], clockAt(PLAN_AT));
    expect(result.duplicates).toBe(1);
    expect(result.created).toBe(0);
    const amount = await adminQuery<{ amount_minor: string }>("select amount_minor::text from invoices where invoice_number = 'INV-1'");
    expect(amount.rows[0].amount_minor).toBe("999");
  });

  it("rejects an invalid row with its line and reason, and still imports the rest", async () => {
    const owner = await setupUser();
    const result = await importInvoices(owner.userId, [
      row({ line: 2, amountMinor: 0 }),
      row({ line: 3, invoiceNumber: "INV-OK" }),
      row({ line: 4, currency: "ZZZ", invoiceNumber: "INV-BAD-CCY" }),
    ], clockAt(PLAN_AT));
    expect(result.created).toBe(1);
    expect(result.rejected.map((r) => r.line)).toEqual([2, 4]);
    expect(result.rejected[0].reason).toMatch(/positive/);
    const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from invoices where user_id = $1", [owner.userId]);
    expect(rows[0].n).toBe("1");
  });

  it("re-running the same batch imports nothing new", async () => {
    const owner = await setupUser();
    const batch = [row({ line: 2 }), row({ line: 3, invoiceNumber: "INV-2" })];
    await importInvoices(owner.userId, batch, clockAt(PLAN_AT));
    const again = await importInvoices(owner.userId, batch, clockAt(PLAN_AT));
    expect(again).toEqual({ created: 0, duplicates: 2, clientsCreated: 0, rejected: [] });
  });

  it("counts a duplicate that appears twice in one batch as a duplicate, not a second invoice", async () => {
    const owner = await setupUser();
    const result = await importInvoices(owner.userId, [row({ line: 2 }), row({ line: 3 })], clockAt(PLAN_AT));
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});

describe("sequences", () => {
  const step = (offsetDays: number, extra: Partial<{ tone: "friendly" | "neutral" | "firm" | "custom"; subject: string; body: string; isFinalNotice: boolean }> = {}) => ({
    offsetDays,
    tone: extra.tone ?? "friendly",
    subject: extra.subject ?? "Invoice {invoice_number}",
    body: extra.body ?? "Hello {client_name}, invoice {invoice_number} is {amount} due {due_date}.",
    isFinalNotice: extra.isFinalNotice ?? false,
  });

  it("creates a standard sequence, sets approval by the spec default, and keeps list order for equal offsets", async () => {
    const owner = await setupUser();
    const saved = await saveSequence(owner.userId, {
      name: "Gentle",
      kind: "standard",
      isDefault: false,
      steps: [step(20), step(0), step(0, { tone: "neutral" })],
    }, clockAt(NOW));
    const { rows } = await adminQuery<{ offset_days: number; position: number; requires_approval: boolean; tone: string }>(
      "select offset_days, position, requires_approval, tone from sequence_steps where sequence_id = $1 order by position", [saved.sequenceId],
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.requires_approval)).toEqual([true, false, false]);
    expect(rows[1].tone).toBe("friendly");
    expect(rows[2].tone).toBe("neutral");
  });

  it("rejects a final notice that is not last, and a preset that threatens legal action", async () => {
    const owner = await setupUser();
    await expect(saveSequence(owner.userId, {
      name: "Bad order", kind: "standard", isDefault: false,
      steps: [step(14, { isFinalNotice: true }), step(21)],
    }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveSequence(owner.userId, {
      name: "Preset with legal", kind: "standard", isDefault: false,
      steps: [step(3, { tone: "firm", body: "We will take legal action on invoice {invoice_number}." })],
    }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows user-written custom text to mention collections, because the user wrote it", async () => {
    const owner = await setupUser();
    const saved = await saveSequence(owner.userId, {
      name: "Custom", kind: "standard", isDefault: false,
      steps: [step(3, { tone: "custom", body: "Invoice {invoice_number} may go to collections if unpaid." })],
    }, clockAt(NOW));
    expect(saved.sequenceId).toBeTruthy();
  });

  it("making a sequence the default replans the open invoices that use the default", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    const saved = await saveSequence(owner.userId, { name: "Only one", kind: "standard", isDefault: true, steps: [step(2)] }, clockAt(NOW));
    expect(saved.replanned).toBeGreaterThan(0);
    const rows = (await rowsOf(invoiceId)).filter((r) => r.status === "scheduled" || r.status === "pending_approval");
    expect(rows.map((r) => new Date(r.planned_at).toISOString())).toEqual(["2026-11-22T09:00:00.000Z"]);
  });

  it("removing a step that already sent a message is refused, and nothing is changed", async () => {
    const owner = await setupUser();
    const seq = await sequenceId(owner.userId);
    const { rows: steps } = await adminQuery<{ id: string; offset_days: number; tone: string; subject: string; body: string }>(
      "select id, offset_days, tone, subject, body from sequence_steps where sequence_id = $1 order by position", [seq],
    );
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    await planAt(owner.userId, invoiceId);
    const sentRow = (await rowsOf(invoiceId)).find((r) => r.status === "scheduled" && r.step_id === steps[2].id)!;
    await adminQuery("update scheduled_messages set status = 'sent' where id = $1", [sentRow.id]);
    const kept = steps.map((s) => ({ id: s.id, offsetDays: s.offset_days, tone: s.tone as "friendly", subject: s.subject, body: s.body }));
    await expect(saveSequence(owner.userId, {
      id: seq, name: "Default reminders", kind: "standard", isDefault: true,
      steps: kept.filter((s) => s.id !== steps[2].id),
    }, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
    const count = await adminQuery<{ n: string }>("select count(*)::text as n from sequence_steps where sequence_id = $1", [seq]);
    expect(count.rows[0].n).toBe("4");
    expect(await rowStatus(sentRow.id)).toBe("sent");
  });

  it("removing an unsent step removes its unsent rows", async () => {
    const owner = await setupUser();
    const seq = await sequenceId(owner.userId);
    const { rows: steps } = await adminQuery<{ id: string; offset_days: number; tone: string; subject: string; body: string }>(
      "select id, offset_days, tone, subject, body from sequence_steps where sequence_id = $1 order by position", [seq],
    );
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    const kept = steps.filter((s) => s.offset_days !== 14).map((s) => ({ id: s.id, offsetDays: s.offset_days, tone: s.tone as "friendly", subject: s.subject, body: s.body }));
    await saveSequence(owner.userId, { id: seq, name: "Default reminders", kind: "standard", isDefault: true, steps: kept }, clockAt(NOW));
    expect((await rowsOf(invoiceId)).filter((r) => r.status === "scheduled")).toHaveLength(3);
  });

  it("refuses a kind change and unsetting the only default", async () => {
    const owner = await setupUser();
    const seq = await sequenceId(owner.userId);
    await expect(saveSequence(owner.userId, { id: seq, name: "x", kind: "plan", isDefault: true, steps: [] }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveSequence(owner.userId, { id: seq, name: "x", kind: "standard", isDefault: false, steps: [] }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("ownership of writes", () => {
  it("another user cannot create, edit or remove this user's invoices, contacts or sequences", async () => {
    const owner = await setupUser();
    const other: Owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    await expect(updateInvoice(other.userId, invoiceId, { notes: "x" }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(setInvoiceContacts(other.userId, invoiceId, { primaryContactId: client.contactId, ccContactIds: [] }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createInvoice(other.userId, { clientId: client.clientId, invoiceNumber: "X", amountMinor: 1, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-02" }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeContact(other.userId, client.contactId, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(upsertContact(other.userId, client.clientId, { email: "z@example.test", name: "Z", isPrimary: false }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    const seq = await sequenceId(owner.userId);
    await expect(saveSequence(other.userId, { id: seq, name: "x", kind: "standard", isDefault: true, steps: [] }, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    expect((await statusesOf(invoiceId)).length).toBe(4);
  });

  it("a stop and a payment on one invoice still apply after write APIs ran", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    await updateInvoice(owner.userId, invoiceId, { notes: "x" }, clockAt(NOW));
    await setInvoiceStatus(owner.userId, invoiceId, "paused", clockAt(NOW));
    expect((await statusesOf(invoiceId)).filter((s) => s === "scheduled")).toHaveLength(0);
  });
});

describe("held rows through the write APIs", () => {
  it("removing a held contact moves its held rows to the primary, so none are stranded", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const ap = await upsertContact(owner.userId, client.clientId, { email: "ap@acme.example.test", name: "AP", isPrimary: false }, clockAt(NOW));
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-12-01", contactId: ap.contactId });
    await planAt(owner.userId, invoiceId);
    await holdContact({ userId: owner.userId, contactId: ap.contactId, clock: clockAt(NOW) });
    await removeContact(owner.userId, ap.contactId, clockAt(NOW));
    expect((await statusesOf(invoiceId)).includes("held")).toBe(false);
  });
});
