// Tenant isolation: row-level security and the engine's user scoping. One user
// cannot read or change another user's invoices, messages or payments.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers/db";
import { closeDb, withUser } from "@/lib/db";
import {
  approveMessage,
  listNeedsYou,
  listNextSevenDays,
  planInvoice,
  recordPayment,
  setInvoiceStatus,
  setAutoSend,
  NotFoundError,
} from "@/lib/engine";
import { NOW, addClient, addInvoice, clockAt, planAt, rowsOf, setupUser } from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("row-level security through withUser", () => {
  it("a user cannot read another user's invoices or scheduled messages", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: true });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-10" });
    await planAt(a.userId, invoiceId);
    const seenByB = await withUser(b.userId, async (c) => {
      const inv = await c.query("select id from invoices");
      const msgs = await c.query("select id from scheduled_messages");
      return { invoices: inv.rows.length, messages: msgs.rows.length };
    });
    expect(seenByB).toEqual({ invoices: 0, messages: 0 });
  });

  it("a user cannot update another user's rows, even with a direct statement", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: true });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-10" });
    await planAt(a.userId, invoiceId);
    const updated = await withUser(b.userId, async (c) => {
      const r = await c.query("update scheduled_messages set status = 'cancelled' where invoice_id = $1", [invoiceId]);
      const inv = await c.query("update invoices set status = 'paid' where id = $1", [invoiceId]);
      return r.rowCount! + inv.rowCount!;
    });
    expect(updated).toBe(0);
    const rows = await rowsOf(invoiceId);
    expect(rows.every((r) => r.status !== "cancelled")).toBe(true);
  });

  it("a user cannot insert rows that belong to another user", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: true });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-10" });
    await expect(
      withUser(b.userId, async (c) => {
        await c.query(
          `insert into events (user_id, invoice_id, type, detail) values ($1, $2, 'forged', '{}')`,
          [a.userId, invoiceId],
        );
      }),
    ).rejects.toThrow();
  });
});

describe("the engine's public API is scoped to the calling user", () => {
  it("setInvoiceStatus, planInvoice and recordPayment refuse another user's invoice", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: true });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-10" });
    await planAt(a.userId, invoiceId);
    await expect(setInvoiceStatus(b.userId, invoiceId, "paused", clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(planInvoice(b.userId, invoiceId, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPayment({ userId: b.userId, invoiceId, installmentId: null, paidAt: new Date(NOW), source: "manual", clock: clockAt(NOW) })).rejects.toBeInstanceOf(NotFoundError);
    const rows = await rowsOf(invoiceId);
    expect(rows.some((r) => r.status === "cancelled" || r.status === "paid")).toBe(false);
    expect(rows.filter((r) => r.status === "scheduled")).toHaveLength(3);
  });

  it("another user cannot approve, or switch auto-send on, for a client they do not own", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: false });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-10" });
    await planAt(a.userId, invoiceId);
    const pending = (await rowsOf(invoiceId)).find((r) => r.status === "pending_approval")!;
    await expect(approveMessage(b.userId, pending.id, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(setAutoSend(b.userId, client.clientId, true, clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    expect((await rowsOf(invoiceId)).filter((r) => r.status === "pending_approval")).toHaveLength(3);
  });

  it("the Needs you queue and the next-7-days view never show another user's items", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const client = await addClient(a.userId, { autoSend: false });
    const invoiceId = await addInvoice(a.userId, client.clientId, { due: "2026-11-12" });
    await planAt(a.userId, invoiceId);
    expect((await listNeedsYou(a.userId)).length).toBeGreaterThan(0);
    expect(await listNeedsYou(b.userId)).toHaveLength(0);
    expect(await listNextSevenDays(b.userId, clockAt(NOW))).toHaveLength(0);
  });
});
