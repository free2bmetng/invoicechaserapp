// Onboarding finish against the real database. Planning goes through the engine's planInvoice.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { clockAt, addInvoice, addPlan, plannedRowCount, setupOwner } from "./fixtures";
import { finishOnboarding, getSettingsView } from "@/lib/queries/settings";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function rowsFor(invoiceId: string): Promise<Array<{ installment_id: string | null; status: string }>> {
  const { rows } = await adminQuery<{ installment_id: string | null; status: string }>(
    "select installment_id, status from scheduled_messages where invoice_id = $1",
    [invoiceId],
  );
  return rows;
}

async function onboardingDone(userId: string): Promise<boolean> {
  const { rows } = await adminQuery<{ onboarding_done: boolean }>("select onboarding_done from settings where user_id = $1", [userId]);
  return rows[0].onboarding_done;
}

describe("the completion gate", () => {
  it("does not finish, plan or flag when sending is not set up", async () => {
    const owner = await setupOwner({ domain: null, reviewed: true });
    const invoice = await addInvoice(owner.userId);
    const result = await finishOnboarding(owner.userId, clockAt());
    expect(result).toEqual({ status: "incomplete", missing: ["Connect sending"] });
    expect(await onboardingDone(owner.userId)).toBe(false);
    expect(await rowsFor(invoice.invoiceId)).toHaveLength(0);
  });

  it("does not finish when the sender profile is incomplete, even with everything else done", async () => {
    const owner = await setupOwner({ profile: false, reviewed: true });
    const result = await finishOnboarding(owner.userId, clockAt());
    expect(result).toEqual({ status: "incomplete", missing: ["Sender details and settings"] });
    expect(await onboardingDone(owner.userId)).toBe(false);
  });

  it("does not finish until the default reminders are reviewed", async () => {
    const owner = await setupOwner();
    const result = await finishOnboarding(owner.userId, clockAt());
    expect(result).toEqual({ status: "incomplete", missing: ["Review the default reminders"] });
  });

  it("does not require invoices: finishing with none is allowed", async () => {
    const owner = await setupOwner({ reviewed: true });
    expect(await finishOnboarding(owner.userId, clockAt())).toEqual({ status: "finished" });
    expect(await onboardingDone(owner.userId)).toBe(true);
  });
});

describe("finishing plans only the invoices that should produce messages", () => {
  it("plans open invoices, plans payment plans with their own rows only, and leaves paid and written-off invoices unplanned", async () => {
    const owner = await setupOwner({ reviewed: true });
    const open = await addInvoice(owner.userId, { status: "open", invoiceNumber: "OPEN-1" });
    const plan = await addInvoice(owner.userId, { status: "open", invoiceNumber: "PLAN-1", amountMinor: 90000 });
    const paid = await addInvoice(owner.userId, { status: "paid", invoiceNumber: "PAID-1" });
    const writtenOff = await addInvoice(owner.userId, { status: "written_off", invoiceNumber: "WO-1" });
    const installments = await addPlan(owner.userId, plan.invoiceId, [
      { due: "2026-11-30", amountMinor: 30000 },
      { due: "2026-12-31", amountMinor: 60000 },
    ]);

    expect(await finishOnboarding(owner.userId, clockAt())).toEqual({ status: "finished" });

    const openRows = await rowsFor(open.invoiceId);
    expect(openRows.length).toBeGreaterThan(0);
    expect(openRows.every((row) => row.installment_id === null)).toBe(true);

    const planRows = await rowsFor(plan.invoiceId);
    expect(planRows.length).toBeGreaterThan(0);
    // A payment plan has no default-sequence rows: every row belongs to an installment.
    expect(planRows.every((row) => row.installment_id !== null)).toBe(true);
    expect(new Set(planRows.map((row) => row.installment_id))).toEqual(new Set(installments));

    expect(await rowsFor(paid.invoiceId)).toHaveLength(0);
    expect(await rowsFor(writtenOff.invoiceId)).toHaveLength(0);
  });
});

describe("finishing is idempotent", () => {
  it("a second finish changes nothing and reports already_done", async () => {
    const owner = await setupOwner({ reviewed: true });
    await addInvoice(owner.userId);
    expect(await finishOnboarding(owner.userId, clockAt())).toEqual({ status: "finished" });
    const plannedAfterFirst = await plannedRowCount(owner.userId);

    expect(await finishOnboarding(owner.userId, clockAt())).toEqual({ status: "already_done" });
    expect(await plannedRowCount(owner.userId)).toBe(plannedAfterFirst);
    expect((await getSettingsView(owner.userId)).settings.onboardingDone).toBe(true);
  });

  it("two finishes in a row produce the same rows as one", async () => {
    const owner = await setupOwner({ reviewed: true });
    const invoice = await addInvoice(owner.userId);
    await finishOnboarding(owner.userId, clockAt());
    const first = (await rowsFor(invoice.invoiceId)).length;
    await finishOnboarding(owner.userId, clockAt());
    expect((await rowsFor(invoice.invoiceId)).length).toBe(first);
  });
});
