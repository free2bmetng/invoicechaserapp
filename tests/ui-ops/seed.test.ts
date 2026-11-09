// The demo seed: run twice against the real database, then checked against the demo
// requirements (every invoice status, a payment plan, the queue states, no real sending).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/lib/db";
import { loadNeedsYou } from "@/lib/queries/ops";
import { loadDashboardState } from "@/lib/queries/dashboard";
import { systemClock } from "@/lib/clock";
import { adminQuery, resetDb } from "../helpers/db";
import { DEMO_EMAIL, seedDemo, type SeedSummary } from "../../scripts/seed";

let first: SeedSummary;
let second: SeedSummary;

beforeAll(async () => {
  await resetDb();
  first = await seedDemo();
  second = await seedDemo();
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe("demo seed", () => {
  it("is safe to run twice: one demo account, rebuilt with the same shape", async () => {
    const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from users where email = $1", [DEMO_EMAIL]);
    expect(rows[0].n).toBe("1");
    expect(second.userId).not.toBe(first.userId);
    expect(second.clients).toBe(first.clients);
    expect(second.invoices).toBe(first.invoices);
    expect(second.clients).toBe(9);
  });

  it("has a complete sender profile, a timezone, and completed onboarding", async () => {
    const { rows } = await adminQuery<Record<string, unknown>>(
      `select sender_name, business_name, postal_address, timezone, onboarding_done from settings where user_id = $1`,
      [second.userId],
    );
    expect(rows[0]).toMatchObject({
      sender_name: "Maya Okafor",
      business_name: "Okafor Studio",
      timezone: "Europe/London",
      onboarding_done: true,
    });
    expect(String(rows[0].postal_address)).not.toBe("");
  });

  it("has a sending domain set, so the sender run can address mail", async () => {
    const { rows } = await adminQuery<{ sending_domain: string | null }>(
      "select sending_domain from settings where user_id = $1",
      [second.userId],
    );
    expect(rows[0].sending_domain).toBe("mail.invoicechaser.test");
  });

  it("spreads the history over several days, in time order, with distinct event times", async () => {
    const { rows } = await adminQuery<{ created_at: Date }>(
      "select created_at from events where user_id = $1 order by id",
      [second.userId],
    );
    const times = rows.map((r) => r.created_at.getTime());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    expect(new Set(times).size).toBeGreaterThan(20);
    const days = await adminQuery<{ n: string }>(
      "select count(distinct (created_at at time zone 'Europe/London')::date)::text as n from events where user_id = $1",
      [second.userId],
    );
    expect(Number(days.rows[0].n)).toBeGreaterThanOrEqual(5);
  });

  it("has an invoice in every status", async () => {
    const { rows } = await adminQuery<{ status: string }>(
      "select distinct status from invoices where user_id = $1",
      [second.userId],
    );
    expect(rows.map((r) => r.status).sort()).toEqual(["disputed", "open", "paid", "paused", "payment_plan", "written_off"]);
  });

  it("has one payment plan with three installments that sum to the invoice, and no unsent or sent reminders from the standard sequence", async () => {
    const plan = await adminQuery<{ id: string; amount_minor: string }>(
      "select id, amount_minor::text from invoices where user_id = $1 and status = 'payment_plan'",
      [second.userId],
    );
    expect(plan.rows).toHaveLength(1);
    const installments = await adminQuery<{ total: string; n: string }>(
      "select sum(amount_minor)::text as total, count(*)::text as n from payment_plan_installments where invoice_id = $1",
      [plan.rows[0].id],
    );
    expect(installments.rows[0].n).toBe("3");
    expect(installments.rows[0].total).toBe(plan.rows[0].amount_minor);

    // Rows planned before the plan was set are skipped, never sent. Nothing from the default
    // sequence may be unsent or dispatched on this invoice.
    const standard = await adminQuery<{ n: string }>(
      `select count(*)::text as n from scheduled_messages m join sequence_steps st on st.id = m.step_id
        join sequences s on s.id = st.sequence_id
        where m.invoice_id = $1 and s.kind = 'standard'
          and m.status in ('pending_approval', 'scheduled', 'held', 'sending', 'sent', 'delivered', 'bounced', 'needs_check')`,
      [plan.rows[0].id],
    );
    expect(standard.rows[0].n).toBe("0");
  });

  it("shows every queue state: approvals, a failed send, a delivery check, a reply, a bounce and a disputed invoice", async () => {
    const view = await loadNeedsYou(second.userId);
    expect(view.sections.map((s) => s.kind)).toEqual(["approval", "failed", "needs_check", "reply", "bounce", "disputed"]);
  });

  it("has the reminder statuses the schedule and message log need", async () => {
    const { rows } = await adminQuery<{ status: string }>(
      "select distinct status from scheduled_messages where user_id = $1",
      [second.userId],
    );
    const statuses = rows.map((r) => r.status);
    for (const expected of ["pending_approval", "scheduled", "held", "sent", "failed", "needs_check"]) {
      expect(statuses).toContain(expected);
    }
  });

  it("holds a bounced address and a client who replied", async () => {
    const bounced = await adminQuery<{ n: string }>(
      "select count(*)::text as n from contacts where user_id = $1 and hold = 'bounced'",
      [second.userId],
    );
    const replied = await adminQuery<{ n: string }>(
      "select count(*)::text as n from clients where user_id = $1 and reply_held_at is not null",
      [second.userId],
    );
    expect(Number(bounced.rows[0].n)).toBeGreaterThanOrEqual(1);
    expect(Number(replied.rows[0].n)).toBeGreaterThanOrEqual(1);
  });

  it("sends nothing real: every logged message went through the fake provider, and no Stripe account exists", async () => {
    const real = await adminQuery<{ n: string }>(
      "select count(*)::text as n from message_log where user_id = $1 and (provider <> 'fake' or provider_message_id not like 'fake_%')",
      [second.userId],
    );
    expect(real.rows[0].n).toBe("0");
    const sent = await adminQuery<{ n: string }>("select count(*)::text as n from message_log where user_id = $1", [second.userId]);
    expect(Number(sent.rows[0].n)).toBeGreaterThan(0);
    const stripe = await adminQuery<{ n: string }>("select count(*)::text as n from connected_accounts where user_id = $1", [second.userId]);
    expect(stripe.rows[0].n).toBe("0");
  });

  it("shows money in each currency on the dashboard, never added together", async () => {
    const state = await loadDashboardState(second.userId, systemClock);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.data.totals.map((t) => t.currency)).toEqual(["EUR", "GBP", "USD"]);
  });

  it("refuses to run when real sending is enabled", async () => {
    vi.stubEnv("SEND_ENABLED", "true");
    try {
      await expect(seedDemo()).rejects.toThrow("SEND_ENABLED");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
