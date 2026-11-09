// Planning: rows per step, dedupe, past-step skipping, approval rules, payment
// plans, step deletion and replanning. Integration tests against Postgres.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import {
  approveMessage,
  deleteStep,
  planInvoice,
  replanSequence,
  setAutoSend,
  setInvoiceStatus,
  setPaymentPlan,
  provisionUser,
  InvalidStateError,
  ValidationError,
} from "@/lib/engine";
import { adminQuery } from "../helpers/db";
import {
  NOW,
  PLAN_AT,
  addClient,
  addInstallments,
  addInvoice,
  clockAt,
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

async function standardSequence(userId: string): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "select id from sequences where user_id = $1 and kind = 'standard' and is_default", [userId],
  );
  return rows[0].id;
}

describe("provisioning", () => {
  it("is idempotent: a second call creates no second settings row or default sequence", async () => {
    const { userId } = await setupUser();
    await provisionUser(userId, clockAt(NOW));
    await provisionUser(userId, clockAt(NOW));
    const settings = await adminQuery<{ n: string }>("select count(*)::text as n from settings where user_id = $1", [userId]);
    const seqs = await adminQuery<{ n: string }>("select count(*)::text as n from sequences where user_id = $1 and is_default", [userId]);
    const steps = await adminQuery<{ offset_days: number; tone: string }>(
      `select st.offset_days, st.tone from sequence_steps st join sequences s on s.id = st.sequence_id
       where s.user_id = $1 and s.kind = 'standard' order by st.position`, [userId],
    );
    expect(settings.rows[0].n).toBe("1");
    expect(seqs.rows[0].n).toBe("2");
    expect(steps.rows.map((r) => r.offset_days)).toEqual([-3, 0, 7, 14]);
    expect(steps.rows.map((r) => r.tone)).toEqual(["friendly", "friendly", "neutral", "firm"]);
  });
});

describe("planning rows", () => {
  it("creates one row per default step keyed invoice:step, planned at 09:00 client time", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true, timezone: "America/New_York" });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    const rows = await rowsOf(invoiceId);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.dedupe_key.startsWith(`${invoiceId}:`)).toBe(true);
    // Step 0 (due date) at 09:00 EST on 2026-11-10 = 14:00Z.
    const dueRow = rows.find((r) => r.dedupe_key.length > 0 && new Date(r.planned_at).toISOString() === "2026-11-10T14:00:00.000Z");
    expect(dueRow).toBeDefined();
  });

  it("skips steps whose planned time has already passed, and never sends them", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId, NOW); // planning after step -3 and step 0 have passed
    const rows = await rowsOf(invoiceId);
    const skipped = rows.filter((r) => r.status === "skipped").length;
    expect(skipped).toBe(2);
    expect(rows.filter((r) => r.status === "scheduled")).toHaveLength(2);
  });

  it("replanning keeps one row per step and does not duplicate", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    const first = (await rowsOf(invoiceId)).map((r) => r.dedupe_key).sort();
    await planAt(userId, invoiceId);
    await planAt(userId, invoiceId);
    const again = (await rowsOf(invoiceId)).map((r) => r.dedupe_key).sort();
    expect(again).toEqual(first);
  });

  it("gives a step over 14 days requires_approval and holds it for approval, even with auto-send", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const { rows: seq } = await adminQuery<{ id: string }>(
      "insert into sequences (user_id, name, kind) values ($1, 'Custom', 'standard') returning id", [userId],
    );
    await adminQuery(
      `insert into sequence_steps (user_id, sequence_id, position, offset_days, tone, subject, body, requires_approval)
       values ($1, $2, 0, 20, 'firm', 'Invoice {invoice_number}', 'Hello {client_name}, pay {amount}.', true)`,
      [userId, seq[0].id],
    );
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10", sequenceId: seq[0].id });
    await planAt(userId, invoiceId);
    const [row] = await rowsOf(invoiceId);
    expect(row.status).toBe("pending_approval");
    expect(row.requires_approval).toBe(true);
  });

  it("holds rule (b) rows for a new client that is not auto-send", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: false });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    const statuses = await statusesOf(invoiceId);
    // Step -3 is already past at planning, so it is skipped. The other three wait for approval.
    expect(statuses.filter((s) => s === "pending_approval")).toHaveLength(3);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(1);
    expect(statuses.filter((s) => s === "scheduled")).toHaveLength(0);
  });

  it("creates no rows when the sender profile is incomplete", async () => {
    const { userId } = await setupUser({ profile: false });
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    expect(await rowsOf(invoiceId)).toHaveLength(0);
  });

  it("creates no rows and logs a block when the invoice has no primary contact", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await adminQuery("delete from contacts where client_id = $1", [client.clientId]);
    await planAt(userId, invoiceId);
    expect(await rowsOf(invoiceId)).toHaveLength(0);
    expect(await eventTypes(invoiceId, "planning_blocked")).toHaveLength(1);
  });

  it("does not plan for a paid invoice", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10", status: "paid" });
    await planAt(userId, invoiceId);
    expect(await rowsOf(invoiceId)).toHaveLength(0);
  });
});

describe("replanning and step edits", () => {
  it("updates unsent rows to a new offset and never touches a dispatched row", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    const seqId = await standardSequence(userId);
    const plus7 = (await adminQuery<{ id: string }>("select id from sequence_steps where sequence_id = $1 and offset_days = 7", [seqId])).rows[0].id;
    const plus14 = (await adminQuery<{ id: string }>("select id from sequence_steps where sequence_id = $1 and offset_days = 14", [seqId])).rows[0].id;
    const before = await rowsOf(invoiceId);
    const sentRow = before.find((r) => r.step_id === plus14)!;
    const movedBefore = before.find((r) => r.step_id === plus7)!;
    expect(new Date(movedBefore.planned_at).toISOString()).toBe("2026-11-27T09:00:00.000Z");
    await adminQuery("update scheduled_messages set status = 'sent' where id = $1", [sentRow.id]);
    await adminQuery("update sequence_steps set offset_days = 9 where id = $1", [plus7]);
    await planAt(userId, invoiceId);
    const after = await rowsOf(invoiceId);
    const sentAfter = after.find((r) => r.id === sentRow.id)!;
    expect(sentAfter.status).toBe("sent");
    expect(new Date(sentAfter.planned_at).toISOString()).toBe(new Date(sentRow.planned_at).toISOString());
    const movedAfter = after.find((r) => r.id === movedBefore.id)!;
    expect(new Date(movedAfter.planned_at).toISOString()).toBe("2026-11-29T09:00:00.000Z");
    expect(after).toHaveLength(before.length);
  });

  it("deleting a step cancels its unsent rows (invoice level rows are removed, installment rows cancelled)", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    const seqId = await standardSequence(userId);
    const { rows } = await adminQuery<{ id: string }>(
      "select id from sequence_steps where sequence_id = $1 and offset_days = 7", [seqId],
    );
    await deleteStep(userId, rows[0].id, clockAt(NOW));
    const after = await rowsOf(invoiceId);
    expect(after.some((r) => r.dedupe_key.endsWith(`:${rows[0].id}`))).toBe(false);
    expect(after.every((r) => r.status !== "sending")).toBe(true);
  });

  it("refuses to delete a step that already has a sent invoice-level message", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    const sent = (await rowsOf(invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set status = 'sent' where id = $1", [sent.id]);
    await expect(deleteStep(userId, sent.step_id!, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("replanSequence re-plans every generating invoice of the user", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    const count = await replanSequence(userId, await standardSequence(userId), clockAt(PLAN_AT));
    expect(count).toBe(1);
    expect(await rowsOf(invoiceId)).toHaveLength(4);
  });
});

describe("payment plans", () => {
  it("plans no default-sequence rows for a payment plan invoice", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10", amountMinor: 100000 });
    await planAt(userId, invoiceId);
    await setPaymentPlan(userId, invoiceId, [
      { dueDate: "2026-12-01", amountMinor: 50000 },
      { dueDate: "2027-01-01", amountMinor: 50000 },
    ], clockAt(PLAN_AT));
    const rows = await rowsOf(invoiceId);
    const standard = rows.filter((r) => r.installment_id === null && r.status !== "cancelled" && r.status !== "skipped");
    expect(standard).toHaveLength(0);
    const planRows = rows.filter((r) => r.installment_id !== null);
    // Three steps per installment: -3, due date and +7.
    expect(planRows).toHaveLength(6);
    expect(planRows.every((r) => r.status === "scheduled")).toBe(true);
    expect((await invoiceRow(invoiceId)).status).toBe("payment_plan");
  });

  it("plans three plan steps per installment (-3, due date, +7), relative to each installment's due date", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10", amountMinor: 100000, status: "payment_plan" });
    await addInstallments(userId, invoiceId, [
      { due: "2026-12-01", amountMinor: 60000 },
      { due: "2026-12-15", amountMinor: 40000 },
    ]);
    await planAt(userId, invoiceId);
    const rows = await rowsOf(invoiceId);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => new Date(r.planned_at).toISOString()).sort()).toEqual([
      "2026-11-28T09:00:00.000Z",
      "2026-12-01T09:00:00.000Z",
      "2026-12-08T09:00:00.000Z",
      "2026-12-12T09:00:00.000Z",
      "2026-12-15T09:00:00.000Z",
      "2026-12-22T09:00:00.000Z",
    ]);
  });

  it("does not plan a paid installment", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10", amountMinor: 100000, status: "payment_plan" });
    const [first] = await addInstallments(userId, invoiceId, [
      { due: "2026-12-01", amountMinor: 60000 },
      { due: "2026-12-15", amountMinor: 40000 },
    ]);
    await adminQuery("update payment_plan_installments set status = 'paid', paid_at = now() where id = $1", [first]);
    await planAt(userId, invoiceId);
    const rows = await rowsOf(invoiceId);
    // Only the open installment is planned: its three steps.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.installment_id === rows[0].installment_id)).toBe(true);
  });

  it("rejects an installment set whose amounts do not sum to the invoice", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { amountMinor: 100000 });
    await expect(
      setPaymentPlan(userId, invoiceId, [
        { dueDate: "2026-12-01", amountMinor: 50000 },
        { dueDate: "2027-01-01", amountMinor: 49999 },
      ], clockAt(PLAN_AT)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await invoiceRow(invoiceId)).status).toBe("open");
  });

  it("rejects a single installment and a non-increasing date order", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { amountMinor: 100000 });
    await expect(setPaymentPlan(userId, invoiceId, [{ dueDate: "2026-12-01", amountMinor: 100000 }], clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
    await expect(setPaymentPlan(userId, invoiceId, [
      { dueDate: "2027-01-01", amountMinor: 50000 },
      { dueDate: "2026-12-01", amountMinor: 50000 },
    ], clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
  });

  it("moving to payment_plan without an installment is refused", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId);
    await expect(setInvoiceStatus(userId, invoiceId, "payment_plan", clockAt(PLAN_AT))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("approval rules across client changes", () => {
  it("turning auto-send on releases rule (b) rows, and skips the ones whose time has passed", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: false });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    expect((await statusesOf(invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(3);
    await setAutoSend(userId, client.clientId, true, clockAt(NOW));
    const statuses = await statusesOf(invoiceId);
    // Step 0 (due 2026-11-10 09:00) is past at NOW, so it is skipped. The two later steps are released.
    expect(statuses.filter((s) => s === "scheduled")).toHaveLength(2);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(2);
    expect(statuses).not.toContain("pending_approval");
  });

  it("does not release a step whose planned time has already passed when auto-send is turned on", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: false });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId, "2026-11-09T12:00:00Z");
    // Step 0 was planned for 2026-11-10 09:00. At 2026-11-11 it is past.
    await setAutoSend(userId, client.clientId, true, clockAt("2026-11-11T12:00:00Z"));
    const rows = await rowsOf(invoiceId);
    expect(rows.some((r) => r.status === "scheduled" && new Date(r.planned_at) < new Date("2026-11-11T00:00:00Z"))).toBe(false);
  });

  it("turning auto-send off with no dispatch returns rule (b) rows to pending approval", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-10" });
    await planAt(userId, invoiceId);
    expect((await statusesOf(invoiceId)).filter((s) => s === "scheduled")).toHaveLength(3);
    await setAutoSend(userId, client.clientId, false, clockAt(NOW));
    expect((await statusesOf(invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(3);
  });

  it("approving a pending row keeps it approved across a later replan", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: false });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    const pending = (await rowsOf(invoiceId)).find((r) => r.status === "pending_approval")!;
    await approveMessage(userId, pending.id, clockAt(NOW));
    await planAt(userId, invoiceId, PLAN_AT);
    const row = (await rowsOf(invoiceId)).find((r) => r.id === pending.id)!;
    expect(row.status).toBe("scheduled");
  });

  it("the planning call does not create a second invoice-level row for a step", async () => {
    const { userId } = await setupUser();
    const client = await addClient(userId, { autoSend: true });
    const invoiceId = await addInvoice(userId, client.clientId, { due: "2026-11-20" });
    await planAt(userId, invoiceId);
    await planAt(userId, invoiceId);
    const invoice = await invoiceRow(invoiceId);
    expect(invoice.status).toBe("open");
    expect(await rowsOf(invoiceId)).toHaveLength(4);
  });
});
