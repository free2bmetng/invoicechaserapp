// Dashboard queries against the real database: per-currency totals, overdue age buckets,
// payment-plan installments, the onboarding gate, and tenant isolation.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, systemClock } from "@/lib/clock";
import { DateTime } from "luxon";
import { closeDb } from "@/lib/db";
import { recordPayment, setInvoiceStatus, setPaymentPlan } from "@/lib/engine";
import { DASHBOARD_NEEDS_PREVIEW, loadCurrencyTotals, loadDashboardState, loadReadyToChase } from "@/lib/queries/dashboard";
import { NEEDS_YOU_SECTIONS } from "@/lib/queries/ops";
import { adminQuery } from "../helpers/db";
import { newClient, newInvoice, newUser, PLAN_ISO, resetDb, runSendWindow, ScriptedEmail, SEND_ISO } from "./fixtures";

// Every totals test uses this as "today", so overdue ages are exact.
const TODAY = "2030-01-15";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe("loadCurrencyTotals", () => {
  it("groups by currency, sorts the groups, and never adds across currencies", async () => {
    const userId = await newUser();
    const client = await newClient(userId, { autoSend: true });
    // USD: overdue at the bucket edges, a due-today invoice, a future one, and excluded statuses.
    await newInvoice(userId, client.clientId, { number: "A", amountMinor: 10000, due: "2030-01-14" }); // 1 day
    const b = await newInvoice(userId, client.clientId, { number: "B", amountMinor: 2000, due: "2029-12-16" }); // 30 days
    await setInvoiceStatus(userId, b, "paused", fixedClock(PLAN_ISO));
    const c = await newInvoice(userId, client.clientId, { number: "C", amountMinor: 3000, due: "2029-12-15" }); // 31 days
    await setInvoiceStatus(userId, c, "disputed", fixedClock(PLAN_ISO));
    await newInvoice(userId, client.clientId, { number: "D", amountMinor: 4000, issue: "2029-10-01", due: "2029-11-15" }); // 61 days
    await newInvoice(userId, client.clientId, { number: "E", amountMinor: 500, due: "2030-01-20" }); // not due yet
    await newInvoice(userId, client.clientId, { number: "H", amountMinor: 1234, due: "2030-01-15" }); // due today: outstanding, not overdue
    const w = await newInvoice(userId, client.clientId, { number: "W", amountMinor: 9999, issue: "2029-10-01", due: "2029-11-01" });
    await setInvoiceStatus(userId, w, "written_off", fixedClock(PLAN_ISO));
    const p = await newInvoice(userId, client.clientId, { number: "P", amountMinor: 7777, issue: "2029-10-01", due: "2029-11-01" });
    await recordPayment({ userId, invoiceId: p, installmentId: null, paidAt: new Date("2029-11-20T12:00:00Z"), source: "manual", clock: fixedClock(PLAN_ISO) });

    // EUR: a payment plan. Open installments count, the paid one does not.
    const eur = await newInvoice(userId, client.clientId, { number: "EUR-1", amountMinor: 300000, currency: "EUR", due: "2030-02-01" });
    await setPaymentPlan(
      userId,
      eur,
      [
        { dueDate: "2029-12-31", amountMinor: 100000 },
        { dueDate: "2030-02-01", amountMinor: 100000 },
        { dueDate: "2030-03-01", amountMinor: 100000 },
      ],
      fixedClock(PLAN_ISO),
    );
    const [firstInstallment] = (await adminQuery<{ id: string }>(
      "select id from payment_plan_installments where invoice_id = $1 order by position limit 1",
      [eur],
    )).rows;
    await recordPayment({
      userId,
      invoiceId: eur,
      installmentId: firstInstallment.id,
      paidAt: new Date("2030-01-02T12:00:00Z"),
      source: "manual",
      clock: fixedClock(PLAN_ISO),
    });

    const totals = await loadCurrencyTotals(userId, TODAY);
    expect(totals.map((t) => t.currency)).toEqual(["EUR", "USD"]);

    const usd = totals.find((t) => t.currency === "USD")!;
    expect(usd.outstandingMinor).toBe(10000 + 2000 + 3000 + 4000 + 500 + 1234);
    expect(usd.overdueMinor).toBe(10000 + 2000 + 3000 + 4000);
    expect(usd.overdueByAge).toEqual({
      days1to30: 10000 + 2000,
      days31to60: 3000,
      days61plus: 4000,
    });

    // The first installment was paid, so only the two open installments count, and neither is overdue.
    const eurTotals = totals.find((t) => t.currency === "EUR")!;
    expect(eurTotals.outstandingMinor).toBe(100000 + 100000);
    expect(eurTotals.overdueMinor).toBe(0);
  });

  it("counts open installments of a payment plan, and their own overdue age", async () => {
    const userId = await newUser();
    const client = await newClient(userId);
    const plan = await newInvoice(userId, client.clientId, { number: "PLAN", amountMinor: 300000, currency: "EUR", due: "2030-02-01" });
    await setPaymentPlan(
      userId,
      plan,
      [
        { dueDate: "2029-12-31", amountMinor: 100000 },
        { dueDate: "2030-02-01", amountMinor: 100000 },
        { dueDate: "2030-03-01", amountMinor: 100000 },
      ],
      fixedClock(PLAN_ISO),
    );
    const totals = await loadCurrencyTotals(userId, TODAY);
    const eur = totals.find((t) => t.currency === "EUR")!;
    expect(eur.outstandingMinor).toBe(300000);
    expect(eur.overdueMinor).toBe(100000);
    expect(eur.overdueByAge.days1to30).toBe(100000);
  });

  it("returns nothing for a user with no unpaid money, and never sees another user's invoices", async () => {
    const owner = await newUser();
    const other = await newUser();
    const client = await newClient(owner);
    await newInvoice(owner, client.clientId, { amountMinor: 5000, due: "2030-01-20" });

    expect(await loadCurrencyTotals(other, TODAY)).toEqual([]);
    expect((await loadCurrencyTotals(owner, TODAY))[0].outstandingMinor).toBe(5000);
  });
});

describe("loadDashboardState (onboarding gate)", () => {
  it("sends a user who has not finished onboarding to the onboarding step, before reading any data", async () => {
    const userId = await newUser({ onboarding: false });
    const client = await newClient(userId);
    await newInvoice(userId, client.clientId);

    const state = await loadDashboardState(userId, fixedClock(PLAN_ISO));
    expect(state.kind).toBe("onboarding");
  });

  it("shows the empty state when onboarding is done but there are no invoices", async () => {
    const userId = await newUser({ onboarding: true });
    expect((await loadDashboardState(userId, fixedClock(PLAN_ISO))).kind).toBe("empty");
  });

  it("returns the data once there is at least one invoice", async () => {
    const userId = await newUser({ onboarding: true });
    const client = await newClient(userId, { name: "Northwind Architects" });
    await newInvoice(userId, client.clientId, { amountMinor: 4800, due: "2030-01-20" });

    const state = await loadDashboardState(userId, fixedClock(PLAN_ISO));
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.data.invoiceCount).toBe(1);
    expect(state.data.totals[0].outstandingMinor).toBe(4800);
    expect(state.data.clients.map((c) => c.name)).toEqual(["Northwind Architects"]);
    expect(state.data.clients[0].averageDaysToPay).toBeNull();
  });
});

describe("client order on the dashboard", () => {
  // Dates are relative to the real current day, because the dashboard reads it.
  const daysAgo = (n: number) => DateTime.now().setZone("UTC").minus({ days: n }).toISODate() ?? "";

  it("orders by the oldest overdue invoice in days, across currencies, then clients with nothing overdue by name", async () => {
    const userId = await newUser({ timezone: "UTC", onboarding: true });

    const alpha = await newClient(userId, { name: "Alpha" });
    await newInvoice(userId, alpha.clientId, { number: "A-1", amountMinor: 100, currency: "USD", issue: daysAgo(60), due: daysAgo(10) });

    const bravo = await newClient(userId, { name: "Bravo" });
    await newInvoice(userId, bravo.clientId, { number: "B-1", amountMinor: 50, currency: "GBP", issue: daysAgo(90), due: daysAgo(40) });

    // The largest overdue amount, but younger than Bravo's, and in another currency.
    const charlie = await newClient(userId, { name: "Charlie" });
    await newInvoice(userId, charlie.clientId, { number: "C-1", amountMinor: 900000000, currency: "EUR", issue: daysAgo(60), due: daysAgo(25) });

    // Paid, so nothing is overdue for this client.
    const delta = await newClient(userId, { name: "Delta" });
    const paid = await newInvoice(userId, delta.clientId, { number: "D-1", amountMinor: 700, currency: "USD", issue: daysAgo(90), due: daysAgo(30) });
    await recordPayment({ userId, invoiceId: paid, installmentId: null, paidAt: new Date(), source: "manual", clock: fixedClock(PLAN_ISO) });

    // Not due yet, so nothing is overdue for this client either.
    const echo = await newClient(userId, { name: "Echo" });
    await newInvoice(userId, echo.clientId, { number: "E-1", amountMinor: 300, currency: "USD", issue: daysAgo(5), due: daysAgo(-5) });

    const state = await loadDashboardState(userId, systemClock);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.data.clients.map((c) => c.name)).toEqual(["Bravo", "Charlie", "Alpha", "Delta", "Echo"]);
  });
});

describe("Needs you preview on the dashboard", () => {
  it("puts failed sends first, then follows the urgency order, with every kind counted", async () => {
    const userId = await newUser({ onboarding: true });
    // Two manual-approval invoices: eight reminders awaiting approval, more than the preview holds.
    const manual = await newClient(userId, { name: "Harbour & Co", autoSend: false });
    await newInvoice(userId, manual.clientId, { number: "HC-1", due: "2030-01-12" });
    await newInvoice(userId, manual.clientId, { number: "HC-2", due: "2030-01-12" });
    // One send the provider refuses: it fails, and was created after the approvals.
    const refused = await newClient(userId, { name: "Orion Logistics", autoSend: true });
    await newInvoice(userId, refused.clientId, { number: "OR-1", due: "2030-01-10" });
    await runSendWindow(new ScriptedEmail(new Set([refused.email])));

    const state = await loadDashboardState(userId, fixedClock(SEND_ISO));
    if (state.kind !== "ready") throw new Error("expected ready");
    const { preview, total, byKind } = state.data.needsYou;
    expect(preview).toHaveLength(DASHBOARD_NEEDS_PREVIEW);
    expect(preview[0].kind).toBe("failed");
    expect(preview[0].clientName).toBe("Orion Logistics");
    expect(preview.slice(1).every((row) => row.kind === "approval")).toBe(true);
    const rank = (kind: string) => NEEDS_YOU_SECTIONS.findIndex((s) => s.kind === kind);
    const ranks = preview.map((row) => rank(row.kind));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(byKind).toEqual({ failed: 1, approval: 8 });
    expect(total).toBe(9);
  });
});

describe("loadReadyToChase", () => {
  it("splits unpaid invoices into queued and the reasons they are not being chased", async () => {
    const userId = await newUser({ onboarding: true });
    const auto = await newClient(userId, { name: "Auto Co", autoSend: true });
    await newInvoice(userId, auto.clientId, { number: "R-1", amountMinor: 1000, due: "2030-01-20" });
    await newInvoice(userId, auto.clientId, { number: "R-2", amountMinor: 2000, currency: "EUR", due: "2030-01-20" });
    const manual = await newClient(userId, { name: "Manual Co", autoSend: false });
    await newInvoice(userId, manual.clientId, { number: "A-1", amountMinor: 3000, due: "2030-01-20" });
    const disputed = await newInvoice(userId, auto.clientId, { number: "D-1", amountMinor: 4000, due: "2030-01-20" });
    await setInvoiceStatus(userId, disputed, "disputed", fixedClock(PLAN_ISO));
    const paused = await newInvoice(userId, auto.clientId, { number: "P-1", amountMinor: 5000, due: "2030-01-20" });
    await setInvoiceStatus(userId, paused, "paused", fixedClock(PLAN_ISO));
    // Every reminder already cancelled: the sequence has nothing left to send.
    const ended = await newInvoice(userId, auto.clientId, { number: "E-1", amountMinor: 6000, due: "2030-01-20" });
    await adminQuery("update scheduled_messages set status = 'cancelled' where invoice_id = $1", [ended]);
    // Paid: not counted anywhere.
    const paid = await newInvoice(userId, auto.clientId, { number: "X-1", amountMinor: 7000, due: "2030-01-20" });
    await recordPayment({ userId, invoiceId: paid, installmentId: null, paidAt: new Date(), source: "manual", clock: fixedClock(PLAN_ISO) });

    const ready = await loadReadyToChase(userId);
    const by = Object.fromEntries(ready.states.map((s) => [s.state, s]));
    expect(ready.states.map((s) => s.state)).toEqual(["ready", "approval", "paused", "disputed", "ended"]);
    expect(by.ready.invoices).toBe(2);
    expect(by.ready.totals).toEqual(expect.arrayContaining([{ currency: "USD", amountMinor: 1000 }, { currency: "EUR", amountMinor: 2000 }]));
    expect(by.approval).toEqual({ state: "approval", invoices: 1, totals: [{ currency: "USD", amountMinor: 3000 }] });
    expect(by.paused.totals).toEqual([{ currency: "USD", amountMinor: 5000 }]);
    expect(by.disputed.totals).toEqual([{ currency: "USD", amountMinor: 4000 }]);
    expect(by.ended.totals).toEqual([{ currency: "USD", amountMinor: 6000 }]);
    expect(ready.nextSendAt).not.toBeNull();

    expect((await loadReadyToChase(await newUser())).states).toEqual([]);
  });
});
