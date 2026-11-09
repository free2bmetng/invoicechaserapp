// Stop conditions and payments (spec 3.4): pause, paid, disputed, written off,
// resume without bursts, skipped rows stay skipped, idempotent payments.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  holdMessage,
  recordPayment,
  runSender,
  setInvoiceStatus,
} from "@/lib/engine";
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
  type Owner,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function openInvoice(owner: Owner, opts: { due?: string; autoSend?: boolean } = {}) {
  const client = await addClient(owner.userId, { autoSend: opts.autoSend ?? true, timezone: "UTC" });
  const invoiceId = await addInvoice(owner.userId, client.clientId, { due: opts.due ?? "2026-11-20" });
  await planAt(owner.userId, invoiceId);
  return { invoiceId, clientId: client.clientId, email: client.email, contactId: client.contactId };
}

describe("pause, paid, disputed and written off", () => {
  it("pausing cancels every unsent row in the same commit and records the prior status", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    const pending = await openInvoice(owner, { autoSend: false });
    const held = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await holdMessage(owner.userId, held.id, clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    const rows = await rowsOf(inv.invoiceId);
    // Four steps are unsent (-3, due date, +7, +14). All four are cancelled, one of them held.
    expect(rows.filter((r) => r.status === "cancelled")).toHaveLength(4);
    expect(rows.find((r) => r.id === held.id)!.prior_status).toMatch(/scheduled$/);
    expect(await eventTypes(inv.invoiceId, "message_cancelled")).toHaveLength(4);
    expect(await eventTypes(inv.invoiceId, "status_changed")).toHaveLength(1);
    // The other invoice is untouched.
    expect((await statusesOf(pending.invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(4);
  });

  it("pausing with queued messages results in zero sends", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner, { due: "2026-11-10" });
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    await runSender(depsFor(clockAt("2026-11-20T12:00:00Z"), email));
    expect(email.calls).toHaveLength(0);
  });

  it("paid sets paid_at, leaves no unsent rows, and nothing is dispatched afterwards", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner, { due: "2026-11-10" });
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paid", clockAt("2026-11-10T11:00:00Z"));
    const row = await invoiceRow(inv.invoiceId);
    expect(row.status).toBe("paid");
    expect(row.paid_at).not.toBeNull();
    expect((await statusesOf(inv.invoiceId)).filter((s) => ["pending_approval", "scheduled", "held"].includes(s))).toHaveLength(0);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(0);
  });

  it("disputed and written off also cancel every unsent row", async () => {
    const owner = await setupUser();
    const a = await openInvoice(owner);
    const b = await openInvoice(owner);
    await setInvoiceStatus(owner.userId, a.invoiceId, "disputed", clockAt(NOW));
    await setInvoiceStatus(owner.userId, b.invoiceId, "written_off", clockAt(NOW));
    expect((await statusesOf(a.invoiceId)).filter((s) => s === "cancelled")).toHaveLength(4);
    expect((await statusesOf(b.invoiceId)).filter((s) => s === "cancelled")).toHaveLength(4);
  });

  it("a status change to the same value does not log a second status_changed event", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    expect(await eventTypes(inv.invoiceId, "status_changed")).toHaveLength(1);
  });
});

describe("resume", () => {
  it("restores cancelled rows whose planned time is still ahead, to their prior status", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt(NOW));
    const statuses = await statusesOf(inv.invoiceId);
    expect(statuses.filter((s) => s === "scheduled")).toHaveLength(4);
  });

  it("does not burst missed steps: rows planned while paused are skipped, not sent", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner, { due: "2026-11-10" });
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt("2026-11-09T12:00:00Z"));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt("2026-11-11T12:00:00Z"));
    const rows = await rowsOf(inv.invoiceId);
    const dueStep = rows.find((r) => new Date(r.planned_at).toISOString() === "2026-11-10T09:00:00.000Z")!;
    expect(dueStep.status).toBe("skipped");
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-11T12:00:00Z"), email));
    expect(email.calls).toHaveLength(0);
    expect(await eventTypes(inv.invoiceId, "message_resumed")).toHaveLength(2);
  });

  it("never revives a row that was skipped", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner, { due: "2026-11-10" });
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt("2026-11-09T12:00:00Z"));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt("2026-11-11T12:00:00Z"));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt("2026-11-11T12:00:00Z"));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt("2026-11-11T12:00:00Z"));
    const skipped = (await rowsOf(inv.invoiceId)).filter((r) => r.status === "skipped");
    // Step -3 was skipped at planning and the due-date step was skipped on the first resume.
    expect(skipped).toHaveLength(2);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-11T12:00:00Z"), email));
    expect(email.calls).toHaveLength(0);
  });

  it("a row held before the pause comes back held, not scheduled", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await holdMessage(owner.userId, row.id, clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt(NOW));
    expect((await rowsOf(inv.invoiceId)).find((r) => r.id === row.id)!.status).toBe("held");
  });

  it("moving to payment_plan needs an installment, and then plans the plan rows only", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await addInstallments(owner.userId, inv.invoiceId, [
      { due: "2026-12-01", amountMinor: 5000 },
      { due: "2026-12-31", amountMinor: 5000 },
    ]);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "payment_plan", clockAt(PLAN_AT));
    const rows = await rowsOf(inv.invoiceId);
    // Two installments, three plan steps each.
    expect(rows.filter((r) => r.installment_id !== null && r.status === "scheduled")).toHaveLength(6);
    expect(rows.filter((r) => r.installment_id === null && (r.status === "scheduled" || r.status === "pending_approval"))).toHaveLength(0);
  });

  it("resume with no installments is refused", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await expect(setInvoiceStatus(owner.userId, inv.invoiceId, "payment_plan", clockAt(NOW))).rejects.toBeInstanceOf(Error);
  });
});

describe("payments", () => {
  it("a manual payment marks the invoice paid and cancels unsent rows", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await recordPayment({ userId: owner.userId, invoiceId: inv.invoiceId, installmentId: null, paidAt: new Date("2026-11-10T11:00:00Z"), source: "manual", clock: clockAt("2026-11-10T11:00:00Z") });
    const row = await invoiceRow(inv.invoiceId);
    expect(row.status).toBe("paid");
    expect(new Date(row.paid_at!).toISOString()).toBe("2026-11-10T11:00:00.000Z");
    expect((await statusesOf(inv.invoiceId)).filter((s) => ["pending_approval", "scheduled", "held"].includes(s))).toHaveLength(0);
    expect(await eventTypes(inv.invoiceId, "payment_recorded")).toHaveLength(1);
  });

  it("recording the same payment twice is a no-op the second time", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    const args = { userId: owner.userId, invoiceId: inv.invoiceId, installmentId: null, source: "stripe" as const, clock: clockAt("2026-11-10T11:00:00Z") };
    await recordPayment({ ...args, paidAt: new Date("2026-11-10T11:00:00Z") });
    const before = await invoiceRow(inv.invoiceId);
    const eventsBefore = (await eventTypes(inv.invoiceId)).length;
    await recordPayment({ ...args, paidAt: new Date("2026-11-12T08:00:00Z") });
    const after = await invoiceRow(inv.invoiceId);
    expect(after.paid_at).toEqual(before.paid_at);
    expect((await eventTypes(inv.invoiceId)).length).toBe(eventsBefore);
  });

  it("two concurrent payments for the same invoice change it once", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    const args = { userId: owner.userId, invoiceId: inv.invoiceId, installmentId: null, source: "stripe" as const, clock: clockAt("2026-11-10T11:00:00Z") };
    await Promise.all([
      recordPayment({ ...args, paidAt: new Date("2026-11-10T11:00:00Z") }),
      recordPayment({ ...args, paidAt: new Date("2026-11-10T11:00:01Z") }),
    ]);
    expect(await eventTypes(inv.invoiceId, "status_changed")).toHaveLength(1);
    expect(await eventTypes(inv.invoiceId, "payment_recorded")).toHaveLength(1);
  });

  it("a payment on a disputed invoice still marks it paid", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "disputed", clockAt(NOW));
    await recordPayment({ userId: owner.userId, invoiceId: inv.invoiceId, installmentId: null, paidAt: new Date("2026-11-10T11:00:00Z"), source: "stripe", clock: clockAt("2026-11-10T11:00:00Z") });
    expect((await invoiceRow(inv.invoiceId)).status).toBe("paid");
  });

  it("an installment payment cancels only that installment's rows", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000, status: "payment_plan" });
    const [first, second] = await addInstallments(owner.userId, invoiceId, [
      { due: "2026-11-20", amountMinor: 5000 },
      { due: "2026-12-20", amountMinor: 5000 },
    ]);
    await planAt(owner.userId, invoiceId);
    await recordPayment({ userId: owner.userId, invoiceId, installmentId: first, paidAt: new Date("2026-11-15T10:00:00Z"), source: "stripe", clock: clockAt("2026-11-15T10:00:00Z") });
    const rows = await rowsOf(invoiceId);
    const firstRows = rows.filter((r) => r.installment_id === first);
    const secondRows = rows.filter((r) => r.installment_id === second);
    expect(firstRows.every((r) => r.status === "cancelled")).toBe(true);
    expect(secondRows.every((r) => r.status === "scheduled")).toBe(true);
    expect((await invoiceRow(invoiceId)).status).toBe("payment_plan");
  });

  it("when every installment is paid, the invoice becomes paid", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 10000, status: "payment_plan" });
    const [first, second] = await addInstallments(owner.userId, invoiceId, [
      { due: "2026-11-20", amountMinor: 5000 },
      { due: "2026-12-20", amountMinor: 5000 },
    ]);
    await planAt(owner.userId, invoiceId);
    await recordPayment({ userId: owner.userId, invoiceId, installmentId: first, paidAt: new Date("2026-11-15T10:00:00Z"), source: "stripe", clock: clockAt("2026-11-15T10:00:00Z") });
    await recordPayment({ userId: owner.userId, invoiceId, installmentId: second, paidAt: new Date("2026-12-18T10:00:00Z"), source: "stripe", clock: clockAt("2026-12-18T10:00:00Z") });
    expect((await invoiceRow(invoiceId)).status).toBe("paid");
    expect((await statusesOf(invoiceId)).filter((s) => ["pending_approval", "scheduled", "held"].includes(s))).toHaveLength(0);
  });

  it("an installment payment for an unknown installment is refused", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await expect(recordPayment({ userId: owner.userId, invoiceId: inv.invoiceId, installmentId: "00000000-0000-4000-8000-000000000000", paidAt: new Date(), source: "stripe", clock: clockAt(NOW) })).rejects.toThrow();
  });

  it("a stop reason is recorded on the cancelled rows", async () => {
    const owner = await setupUser();
    const inv = await openInvoice(owner);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "written_off", clockAt(NOW));
    const reasons = await adminQuery<{ reason: string }>(
      "select detail->>'reason' as reason from events where invoice_id = $1 and type = 'message_cancelled'", [inv.invoiceId],
    );
    expect(reasons.rows.every((r) => r.reason === "written_off")).toBe(true);
  });
});
