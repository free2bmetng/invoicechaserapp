// Platform webhook for Connect OAuth accounts (/api/webhooks/stripe). Each event carries
// event.account, and that account's user is the one it may settle. recordPayment is mocked.
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV } from "../helpers/env";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { seedClientAndInvoice, seedStripeOAuthConnection } from "./fixtures";

vi.mock("@/lib/engine", () => ({
  recordPayment: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/webhooks/stripe/route";
import { recordPayment } from "@/lib/engine";

const CONNECT_SECRET = "whsec_connect_platform_test";
const CREATED = 1_794_000_000;

function sessionEvent(opts: {
  id: string;
  account?: string;
  metadata?: Record<string, string> | null;
  paymentStatus?: "paid" | "unpaid";
}): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    created: CREATED,
    type: "checkout.session.completed",
    livemode: false,
    ...(opts.account ? { account: opts.account } : {}),
    data: {
      object: {
        id: `cs_${opts.id}`,
        object: "checkout.session",
        payment_status: opts.paymentStatus ?? "paid",
        metadata: opts.metadata ?? null,
      },
    },
  });
}

function deliver(payload: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  return POST(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: payload, headers }));
}

function signed(payload: string, secret = CONNECT_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function storedEvents(): Promise<Array<{ event_id: string; user_id: string | null }>> {
  const { rows } = await adminQuery<{ event_id: string; user_id: string | null }>(
    "select event_id, user_id from stripe_events order by event_id",
  );
  return rows;
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform webhook: signature", () => {
  it("returns 400 for a missing signature and for a signature from the wrong secret", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    await seedStripeOAuthConnection(userId, "acct_one");
    const payload = sessionEvent({ id: "evt_sig", account: "acct_one", metadata: { invoice_id: invoiceId, user_id: userId } });

    expect((await deliver(payload, null)).status).toBe(400);
    expect((await deliver(payload, signed(payload, TEST_ENV.STRIPE_WEBHOOK_SECRET))).status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("returns 500 when the Connect webhook secret is not configured", async () => {
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    const payload = sessionEvent({ id: "evt_nosecret", account: "acct_one" });
    expect((await deliver(payload, signed(payload))).status).toBe(500);
    expect(recordPayment).not.toHaveBeenCalled();
  });
});

describe("platform webhook: routing by connected account", () => {
  it("applies a paid checkout to the user who owns event.account, and records the event against that user", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    await seedStripeOAuthConnection(userId, "acct_owner");
    const payload = sessionEvent({ id: "evt_ok", account: "acct_owner", metadata: { invoice_id: invoiceId, user_id: userId } });

    const res = await deliver(payload, signed(payload));
    expect(res.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ userId, invoiceId, source: "stripe" }));
    expect(await storedEvents()).toEqual([{ event_id: "evt_ok", user_id: userId }]);
  });

  it("acknowledges events without an account and does not apply or record them", async () => {
    const payload = sessionEvent({ id: "evt_platform", metadata: null });
    const res = await deliver(payload, signed(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: "not a connected-account event" });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("acknowledges events from an account nobody has connected, so Stripe stops retrying", async () => {
    const payload = sessionEvent({ id: "evt_stranger", account: "acct_nobody", metadata: null });
    const res = await deliver(payload, signed(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: "unknown account" });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("is a no-op for a repeated delivery of the same event", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    await seedStripeOAuthConnection(userId, "acct_owner");
    const payload = sessionEvent({ id: "evt_dupe", account: "acct_owner", metadata: { invoice_id: invoiceId, user_id: userId } });
    const signature = signed(payload);

    await deliver(payload, signature);
    const again = await deliver(payload, signature);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(recordPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses metadata that names another user than the account's owner, even with a valid signature", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    const { invoiceId: otherInvoice } = await seedClientAndInvoice(other);
    await seedStripeOAuthConnection(owner, "acct_owner");
    const payload = sessionEvent({ id: "evt_cross", account: "acct_owner", metadata: { invoice_id: otherInvoice, user_id: other } });

    await expect(deliver(payload, signed(payload))).rejects.toThrow(/different account/);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("ignores an unpaid session on a connected account but records the event", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    await seedStripeOAuthConnection(userId, "acct_owner");
    const payload = sessionEvent({
      id: "evt_unpaid",
      account: "acct_owner",
      paymentStatus: "unpaid",
      metadata: { invoice_id: invoiceId, user_id: userId },
    });
    expect((await deliver(payload, signed(payload))).status).toBe(200);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([{ event_id: "evt_unpaid", user_id: userId }]);
  });
});

afterAll(async () => {
  await closeDb();
});
