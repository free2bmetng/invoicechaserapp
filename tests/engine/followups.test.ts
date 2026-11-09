// Days to pay (from the due date), payments on disputed or written-off invoices, and the
// default payment-plan sequence for new users.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import {
  acknowledgePaidWhileDisputed,
  listClients,
  listNeedsYou,
  listSequences,
  provisionUser,
  recordPayment,
  runSender,
  setInvoiceStatus,
} from "@/lib/engine";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  NOW,
  PLAN_AT,
  addClient,
  addInstallments,
  addInvoice,
  clockAt,
  depsFor,
  eventTypes,
  invoiceRow,
  planAt,
  rowsOf,
  setupUser,
  statusesOf,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function paidOn(userId: string, invoiceId: string, iso: string): Promise<void> {
  await recordPayment({
    userId,
    invoiceId,
    installmentId: null,
    paidAt: new Date(iso),
    source: "manual",
    clock: clockAt(iso),
  });
}

async function clientRow(userId: string, clientId: string) {
  const rows = await listClients(userId, clockAt(NOW));
  return rows.find((c) => c.id === clientId)!;
}

describe("days to pay, measured from the due date", () => {
  it("a client who pays early has a negative average days late", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Early Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "E-1", issue: "2026-10-01", due: "2026-11-10" });
    await paidOn(owner.userId, invoice, "2026-11-07T12:00:00Z");
    const row = await clientRow(owner.userId, client.clientId);
    expect(row.avgDaysLate).toBe(-3);
    // The issue-date figure stays as the secondary display: 1 Oct to 7 Nov is 37 days.
    expect(row.averageDaysToPay).toBe(37);
  });

  it("a client who pays on the due date has an average days late of zero", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "On Time Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "O-1", issue: "2026-10-01", due: "2026-11-10" });
    await paidOn(owner.userId, invoice, "2026-11-10T12:00:00Z");
    expect((await clientRow(owner.userId, client.clientId)).avgDaysLate).toBe(0);
  });

  it("a client who pays late has a positive average days late", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Late Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "L-1", issue: "2026-10-01", due: "2026-11-10" });
    await paidOn(owner.userId, invoice, "2026-11-15T12:00:00Z");
    expect((await clientRow(owner.userId, client.clientId)).avgDaysLate).toBe(5);
  });

  it("averages early, on-time and late payments together, and is null with no paid invoices", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Mixed Ltd", timezone: "UTC" });
    const none = await clientRow(owner.userId, client.clientId);
    expect(none.avgDaysLate).toBeNull();
    const early = await addInvoice(owner.userId, client.clientId, { number: "M-1", due: "2026-11-10" });
    const onTime = await addInvoice(owner.userId, client.clientId, { number: "M-2", due: "2026-11-10" });
    const late = await addInvoice(owner.userId, client.clientId, { number: "M-3", due: "2026-11-10" });
    await paidOn(owner.userId, early, "2026-11-07T12:00:00Z");
    await paidOn(owner.userId, onTime, "2026-11-10T12:00:00Z");
    await paidOn(owner.userId, late, "2026-11-15T12:00:00Z");
    // (-3 + 0 + 5) / 3 = 0.67, rounded to one decimal.
    expect((await clientRow(owner.userId, client.clientId)).avgDaysLate).toBe(0.7);
  });
});

describe("payment on a disputed or written-off invoice", () => {
  it("a payment on a disputed invoice still marks it paid, logs paid_while_disputed, and raises an item", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Harbour & Co", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "HC-9", due: "2026-11-20" });
    await setInvoiceStatus(owner.userId, invoice, "disputed", clockAt(NOW));
    await paidOn(owner.userId, invoice, "2026-11-12T12:00:00Z");
    expect((await invoiceRow(invoice)).status).toBe("paid");
    const flag = await adminQuery<{ detail: { prior_status: string } }>(
      "select detail from events where invoice_id = $1 and type = 'paid_while_disputed'", [invoice],
    );
    expect(flag.rows).toHaveLength(1);
    expect(flag.rows[0].detail.prior_status).toBe("disputed");
    const items = (await listNeedsYou(owner.userId)).filter((i) => i.kind === "paid_while_disputed");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Paid while disputed. Check the dispute is resolved.");
    expect(items[0].invoiceId).toBe(invoice);
  });

  it("a payment on a written-off invoice records the written-off prior status", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Ledger Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "W-1", due: "2026-11-20" });
    await setInvoiceStatus(owner.userId, invoice, "written_off", clockAt(NOW));
    await paidOn(owner.userId, invoice, "2026-11-12T12:00:00Z");
    const flag = await adminQuery<{ detail: { prior_status: string } }>(
      "select detail from events where invoice_id = $1 and type = 'paid_while_disputed'", [invoice],
    );
    expect(flag.rows[0].detail.prior_status).toBe("written_off");
    const item = (await listNeedsYou(owner.userId)).find((i) => i.kind === "paid_while_disputed")!;
    expect(item.detail).toContain("written off");
  });

  it("a normal payment on an open invoice logs nothing and raises no item", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Plain Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "P-1", due: "2026-11-20" });
    await paidOn(owner.userId, invoice, "2026-11-12T12:00:00Z");
    expect(await eventTypes(invoice, "paid_while_disputed")).toHaveLength(0);
    expect((await listNeedsYou(owner.userId)).some((i) => i.kind === "paid_while_disputed")).toBe(false);
  });

  it("the item stays until acknowledged, and acknowledging clears it and logs an event", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Ack Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "A-1", due: "2026-11-20" });
    await setInvoiceStatus(owner.userId, invoice, "disputed", clockAt(NOW));
    await paidOn(owner.userId, invoice, "2026-11-12T12:00:00Z");
    const stillOpen = await listNeedsYou(owner.userId);
    expect(stillOpen.some((i) => i.kind === "paid_while_disputed")).toBe(true);

    const first = await acknowledgePaidWhileDisputed(owner.userId, invoice, clockAt("2026-11-12T13:00:00Z"));
    expect(first).toEqual({ acknowledged: true });
    expect((await listNeedsYou(owner.userId)).some((i) => i.kind === "paid_while_disputed")).toBe(false);
    expect(await eventTypes(invoice, "paid_while_disputed_acknowledged")).toHaveLength(1);

    const second = await acknowledgePaidWhileDisputed(owner.userId, invoice, clockAt("2026-11-12T13:05:00Z"));
    expect(second).toEqual({ acknowledged: false });
    expect(await eventTypes(invoice, "paid_while_disputed_acknowledged")).toHaveLength(1);
  });

  it("acknowledging an invoice with no open item does nothing", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Quiet Ltd", timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "Q-1", due: "2026-11-20" });
    expect(await acknowledgePaidWhileDisputed(owner.userId, invoice, clockAt(NOW))).toEqual({ acknowledged: false });
    expect(await eventTypes(invoice, "paid_while_disputed_acknowledged")).toHaveLength(0);
  });

  it("a plan paid in full while disputed is logged once, and a partial installment payment is not", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Plan Ltd", autoSend: true, timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "PL-1", amountMinor: 10000, due: "2026-11-20", status: "payment_plan" });
    const [first, second] = await addInstallments(owner.userId, invoice, [
      { due: "2026-11-20", amountMinor: 5000 },
      { due: "2026-12-20", amountMinor: 5000 },
    ]);
    await planAt(owner.userId, invoice);
    await setInvoiceStatus(owner.userId, invoice, "disputed", clockAt(NOW));
    await recordPayment({ userId: owner.userId, invoiceId: invoice, installmentId: first, paidAt: new Date("2026-11-12T12:00:00Z"), source: "stripe", clock: clockAt("2026-11-12T12:00:00Z") });
    expect((await invoiceRow(invoice)).status).toBe("disputed");
    expect(await eventTypes(invoice, "paid_while_disputed")).toHaveLength(0);
    await recordPayment({ userId: owner.userId, invoiceId: invoice, installmentId: second, paidAt: new Date("2026-12-15T12:00:00Z"), source: "stripe", clock: clockAt("2026-12-15T12:00:00Z") });
    expect((await invoiceRow(invoice)).status).toBe("paid");
    expect(await eventTypes(invoice, "paid_while_disputed")).toHaveLength(1);
  });
});

describe("the default payment-plan sequence for new users", () => {
  it("has three steps per installment: -3, the due date and +7", async () => {
    const owner = await setupUser();
    const plan = (await listSequences(owner.userId)).find((s) => s.kind === "plan" && s.isDefault)!;
    expect(plan.steps.map((s) => s.offsetDays)).toEqual([-3, 0, 7]);
    expect(plan.steps.map((s) => s.tone)).toEqual(["friendly", "friendly", "neutral"]);
  });

  it("a plan gets three rows per installment, and the +7 row is cancelled when its installment is paid", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Steps Ltd", autoSend: true, timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "S-1", amountMinor: 10000, due: "2026-11-10", status: "payment_plan" });
    const [first, second] = await addInstallments(owner.userId, invoice, [
      { due: "2026-11-20", amountMinor: 5000 },
      { due: "2026-12-20", amountMinor: 5000 },
    ]);
    await planAt(owner.userId, invoice, PLAN_AT);
    const rows = await rowsOf(invoice);
    expect(rows.filter((r) => r.installment_id === first)).toHaveLength(3);
    expect(rows.filter((r) => r.installment_id === second)).toHaveLength(3);
    await recordPayment({ userId: owner.userId, invoiceId: invoice, installmentId: first, paidAt: new Date("2026-11-18T12:00:00Z"), source: "stripe", clock: clockAt("2026-11-18T12:00:00Z") });
    const after = await rowsOf(invoice);
    const seven = await adminQuery<{ id: string }>(
      `select m.id from scheduled_messages m join sequence_steps st on st.id = m.step_id
       where m.invoice_id = $1 and m.installment_id = $2 and st.offset_days = 7`,
      [invoice, first],
    );
    expect(after.find((r) => r.id === seven.rows[0].id)!.status).toBe("cancelled");
    expect(after.filter((r) => r.installment_id === first).every((r) => r.status === "cancelled")).toBe(true);
    expect(after.filter((r) => r.installment_id === second).every((r) => r.status === "scheduled")).toBe(true);
  });

  it("an existing plan keeps its own sequence: re-provisioning does not restore removed steps", async () => {
    const owner = await setupUser();
    await adminQuery(
      `delete from sequence_steps where sequence_id = (select id from sequences where user_id = $1 and kind = 'plan' and is_default)
         and offset_days = 7`,
      [owner.userId],
    );
    await provisionUser(owner.userId, clockAt(NOW));
    const plan = (await listSequences(owner.userId)).find((s) => s.kind === "plan" && s.isDefault)!;
    expect(plan.steps.map((s) => s.offsetDays)).toEqual([-3, 0]);
  });

  it("a plan sends its step on the due date for an unpaid installment", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { name: "Due Ltd", autoSend: true, timezone: "UTC" });
    const invoice = await addInvoice(owner.userId, client.clientId, { number: "D-1", amountMinor: 10000, due: "2026-11-10", status: "payment_plan" });
    await addInstallments(owner.userId, invoice, [{ due: "2026-11-10", amountMinor: 10000 }]);
    await planAt(owner.userId, invoice, PLAN_AT);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].subject).toContain("D-1");
    expect((await statusesOf(invoice)).filter((s) => s === "sent")).toHaveLength(1);
  });
});


