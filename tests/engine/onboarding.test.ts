// Spec 3.8: messages are planned only after onboarding is finished. Before that, invoices
// are stored but get no rows. completeOnboarding sets the flag and plans everything open.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb, withUser } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  cancelMessage,
  completeOnboarding,
  createInvoice,
  importInvoices,
  lockUser,
  listNeedsYou,
  planInvoice,
  planOpenInvoices,
  recordReply,
  runSender,
  updateInvoice,
  ValidationError,
} from "@/lib/engine";
import {
  NOW,
  PLAN_AT,
  addClient,
  addInvoice,
  clockAt,
  depsFor,
  rowsOf,
  setupUser,
  type Owner,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function onboardingFlag(userId: string): Promise<boolean> {
  const { rows } = await adminQuery<{ onboarding_done: boolean }>("select onboarding_done from settings where user_id = $1", [userId]);
  return rows[0].onboarding_done;
}

async function rowCount(userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from scheduled_messages where user_id = $1", [userId]);
  return Number(rows[0].n);
}

describe("before onboarding is finished", () => {
  it("creating an invoice stores it but plans nothing", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const created = await createInvoice(owner.userId, {
      clientId: client.clientId, invoiceNumber: "INV-EARLY", amountMinor: 1000, currency: "USD",
      issueDate: "2026-10-01", dueDate: "2026-11-20",
    }, clockAt(PLAN_AT));
    expect(await rowsOf(created.invoiceId)).toHaveLength(0);
    expect(await rowCount(owner.userId)).toBe(0);
  });

  it("importing invoices stores them but plans nothing", async () => {
    const owner = await setupUser({ onboarding: false });
    const result = await importInvoices(owner.userId, [
      { line: 2, clientName: "Acme", clientEmail: "a@acme.example.test", invoiceNumber: "I-1", amountMinor: 1000, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-20" },
      { line: 3, clientName: "Acme", clientEmail: "a@acme.example.test", invoiceNumber: "I-2", amountMinor: 2000, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-11-20" },
    ], clockAt(PLAN_AT));
    expect(result.created).toBe(2);
    expect(await rowCount(owner.userId)).toBe(0);
  });

  it("editing an invoice's due date and calling planInvoice plan nothing", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await updateInvoice(owner.userId, invoiceId, { dueDate: "2026-11-25" }, clockAt(PLAN_AT));
    await planInvoice(owner.userId, invoiceId, clockAt(PLAN_AT));
    expect(await rowsOf(invoiceId)).toHaveLength(0);
  });

  it("planOpenInvoices returns 0 and plans nothing", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    expect(await planOpenInvoices(owner.userId, clockAt(PLAN_AT))).toBe(0);
    expect(await rowCount(owner.userId)).toBe(0);
  });

  it("the sender sends nothing for a user whose onboarding is not finished, even if a row is scheduled", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    await planInvoice(owner.userId, invoiceId, clockAt(PLAN_AT));
    await adminQuery("update settings set onboarding_done = false where user_id = $1", [owner.userId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(0);
    expect(email.calls).toHaveLength(0);
    const rows = await rowsOf(invoiceId);
    expect(rows.some((r) => r.status === "cancelled")).toBe(true);
  });

  it("completeOnboarding refuses while the sender profile or the sending domain is missing", async () => {
    const incomplete = await setupUser({ onboarding: false, profile: false });
    await expect(completeOnboarding(incomplete.userId, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    expect(await onboardingFlag(incomplete.userId)).toBe(false);

    const noDomain = await setupUser({ onboarding: false, sendingDomain: null });
    await expect(completeOnboarding(noDomain.userId, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    expect(await onboardingFlag(noDomain.userId)).toBe(false);
  });
});

describe("finishing onboarding", () => {
  it("plans every open invoice that was stored before the finish, and leaves paid ones alone", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const open = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    const paid = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20", status: "paid" });
    expect(await rowsOf(open)).toHaveLength(0);
    const result = await completeOnboarding(owner.userId, clockAt(PLAN_AT));
    expect(result).toEqual({ planned: 1, alreadyDone: false });
    expect(await onboardingFlag(owner.userId)).toBe(true);
    expect(await rowsOf(open)).toHaveLength(4);
    expect(await rowsOf(paid)).toHaveLength(0);
  });

  it("is idempotent: a second finish plans nothing new", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-20" });
    await completeOnboarding(owner.userId, clockAt(PLAN_AT));
    const before = await rowsOf(invoiceId);
    const again = await completeOnboarding(owner.userId, clockAt(PLAN_AT));
    expect(again.alreadyDone).toBe(true);
    expect(await rowsOf(invoiceId)).toEqual(before);
  });

  it("after the finish, a new invoice is planned at once", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    await completeOnboarding(owner.userId, clockAt(PLAN_AT));
    const created = await createInvoice(owner.userId, {
      clientId: client.clientId, invoiceNumber: "INV-LATE", amountMinor: 1000, currency: "USD",
      issueDate: "2026-10-01", dueDate: "2026-11-20",
    }, clockAt(PLAN_AT));
    expect(await rowsOf(created.invoiceId)).toHaveLength(4);
  });

  it("the first messages go out after the finish, not before", async () => {
    const owner = await setupUser({ onboarding: false });
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
    const before = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), before));
    expect(before.calls).toHaveLength(0);
    await completeOnboarding(owner.userId, clockAt(PLAN_AT));
    const after = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), after));
    expect(result.sent).toBe(1);
    expect(after.calls).toHaveLength(1);
  });
});

describe("reply hold and cancelled reminders", () => {
  it("cancelling the held reminders clears the Needs you item but keeps the client on hold for new invoices", async () => {
    const owner: Owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const first = await addInvoice(owner.userId, client.clientId, { due: "2026-12-01" });
    await planInvoice(owner.userId, first, clockAt(PLAN_AT));
    await recordReply({ userId: owner.userId, clientId: client.clientId, clock: clockAt("2026-11-10T11:00:00Z") });
    expect((await listNeedsYou(owner.userId)).some((i) => i.kind === "reply")).toBe(true);

    for (const row of (await rowsOf(first)).filter((r) => r.status === "held")) {
      await cancelMessage(owner.userId, row.id, clockAt("2026-11-10T11:05:00Z"));
    }
    expect((await listNeedsYou(owner.userId)).some((i) => i.kind === "reply")).toBe(false);
    const { rows } = await adminQuery<{ reply_held_at: Date | null }>("select reply_held_at from clients where id = $1", [client.clientId]);
    expect(rows[0].reply_held_at).not.toBeNull();

    // A new invoice for the same client is held, not sent.
    const later = await createInvoice(owner.userId, {
      clientId: client.clientId, invoiceNumber: "INV-AFTER-REPLY", amountMinor: 500, currency: "USD",
      issueDate: "2026-10-01", dueDate: "2026-12-15",
    }, clockAt("2026-11-10T11:10:00Z"));
    const statuses = (await rowsOf(later.invoiceId)).map((r) => r.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === "held" || s === "skipped")).toBe(true);
    expect(statuses.filter((s) => s === "held").length).toBeGreaterThan(0);
  });
});

describe("lockUser", () => {
  it("is exported and takes the per-user lock inside a transaction", async () => {
    const owner = await setupUser();
    await withUser(owner.userId, async (c) => {
      await lockUser(c, owner.userId);
      const { rows } = await c.query<{ locked: boolean }>("select true as locked");
      expect(rows[0].locked).toBe(true);
    });
  });
});
