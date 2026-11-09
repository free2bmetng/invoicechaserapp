// Per-connection Stripe webhook route against the real database. recordPayment is mocked, so
// the tests cover signature checks (each connection's own secret), token routing, the
// stripe_events dedupe, and crash safety. Signed test payloads are built locally; nothing
// calls Stripe.
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV } from "../helpers/env";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { seedClientAndInvoice, seedInstallment, seedStripeConnection } from "./fixtures";

vi.mock("@/lib/engine", () => ({
  recordPayment: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/webhooks/stripe/[token]/route";
import { recordPayment } from "@/lib/engine";

const CREATED = 1_794_000_000; // seconds; a fixed event time, so paidAt is predictable
const UNKNOWN_USER = "44444444-4444-4444-8444-444444444444";

type Meta = Record<string, string>;

function sessionEvent(opts: {
  id: string;
  metadata?: Meta | null;
  paymentStatus?: "paid" | "unpaid" | "no_payment_required";
  created?: number;
}): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    created: opts.created ?? CREATED,
    type: "checkout.session.completed",
    livemode: false,
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

function signatureFor(payload: string, secret: string, timestamp?: number): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

// Calls the exported handler the way Next does: a Request plus the route params promise.
function deliver(token: string, payload: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  const request = new Request(`http://localhost:3000/api/webhooks/stripe/${token}`, {
    method: "POST",
    body: payload,
    headers,
  });
  return POST(request, { params: Promise.resolve({ token }) });
}

async function storedEvents(): Promise<Array<{ event_id: string; user_id: string | null }>> {
  const { rows } = await adminQuery<{ event_id: string; user_id: string | null }>(
    "select event_id, user_id from stripe_events order by event_id",
  );
  return rows;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stripe webhook: signature and routing", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });

  it("accepts a paid checkout signed with the connection's own secret and records the event", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({
      id: "evt_valid",
      metadata: { invoice_id: invoiceId, user_id: userId, payable_id: invoiceId },
    });

    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(await storedEvents()).toEqual([{ event_id: "evt_valid", user_id: userId }]);
  });

  it("returns 404 for a token that matches no connection, and reads nothing else", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_unknown_token", metadata: { invoice_id: invoiceId, user_id: userId } });

    const res = await deliver("unknown-token-value-000000", payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(404);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("returns 404 for a malformed token without a database lookup", async () => {
    const res = await deliver("short", sessionEvent({ id: "evt_bad_token" }), "t=1,v1=00");
    expect(res.status).toBe(404);
  });

  it("returns 404 unless STRIPE_KEY_MODE=restricted, so the per-connection route is inert for OAuth", async () => {
    vi.stubEnv("STRIPE_KEY_MODE", "");
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_gated", metadata: null });
    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(404);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("returns 400 when the event is signed with another connection's secret", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    const { invoiceId } = await seedClientAndInvoice(owner);
    const ownerConn = await seedStripeConnection(owner);
    const otherConn = await seedStripeConnection(other);
    const payload = sessionEvent({ id: "evt_cross", metadata: { invoice_id: invoiceId, user_id: owner } });

    const res = await deliver(ownerConn.token, payload, signatureFor(payload, otherConn.signingSecret));
    expect(res.status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("does not verify against the environment's STRIPE_WEBHOOK_SECRET", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_env", metadata: { invoice_id: invoiceId, user_id: userId } });

    const res = await deliver(token, payload, signatureFor(payload, TEST_ENV.STRIPE_WEBHOOK_SECRET));
    expect(res.status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("returns 400 when the body was tampered with after signing", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const original = sessionEvent({
      id: "evt_tamper",
      metadata: { invoice_id: invoiceId, user_id: userId, payable_id: invoiceId },
    });
    const tampered = original.split(invoiceId).join(UNKNOWN_USER);

    const res = await deliver(token, tampered, signatureFor(original, signingSecret));
    expect(res.status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("returns 400 for a missing Stripe-Signature header", async () => {
    const userId = await createUser("owner@example.test");
    const { token } = await seedStripeConnection(userId);
    const res = await deliver(token, sessionEvent({ id: "evt_none" }), null);
    expect(res.status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("returns 400 for a correctly signed event outside Stripe's 5-minute tolerance", async () => {
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_stale", metadata: null });
    const stale = Math.floor(Date.now() / 1000) - 3600;

    const res = await deliver(token, payload, signatureFor(payload, signingSecret, stale));
    expect(res.status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("fails with a server error, not a 400, when the stored signing secret cannot be decrypted", async () => {
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    await adminQuery("update connected_accounts set webhook_secret_ciphertext = 'not-ciphertext' where user_id = $1", [userId]);
    const payload = sessionEvent({ id: "evt_undecryptable", metadata: null });

    await expect(deliver(token, payload, signatureFor(payload, signingSecret))).rejects.toThrow();
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("returns 404 once the connection is removed, so later deliveries are no-ops", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    await adminQuery("delete from connected_accounts where user_id = $1", [userId]);
    const payload = sessionEvent({ id: "evt_removed", metadata: { invoice_id: invoiceId, user_id: userId } });

    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(404);
    expect(recordPayment).not.toHaveBeenCalled();
  });
});

describe("stripe webhook: paid checkout sessions", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });

  it("calls recordPayment once with source stripe, the connection's user, and the event time as paidAt", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_one", metadata: { invoice_id: invoiceId, user_id: userId } });

    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(recordPayment).toHaveBeenCalledWith({
      userId,
      invoiceId,
      installmentId: null,
      paidAt: new Date(CREATED * 1000),
      source: "stripe",
      clock: expect.objectContaining({ now: expect.any(Function) }),
    });
  });

  it("is a no-op for a repeated delivery of the same event", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_dupe", metadata: { invoice_id: invoiceId, user_id: userId } });
    const signature = signatureFor(payload, signingSecret);

    const first = await deliver(token, payload, signature);
    const second = await deliver(token, payload, signature);
    const third = await deliver(token, payload, signature);

    expect(first.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(third.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(await storedEvents()).toHaveLength(1);
  });

  it("calls recordPayment once per distinct event, even for the same invoice", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const meta = { invoice_id: invoiceId, user_id: userId };
    for (const id of ["evt_a", "evt_b"]) {
      const payload = sessionEvent({ id, metadata: meta });
      await deliver(token, payload, signatureFor(payload, signingSecret));
    }
    expect(recordPayment).toHaveBeenCalledTimes(2);
    expect(await storedEvents()).toHaveLength(2);
  });

  it("passes an installment id for a plan payable, from either metadata key", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId, { amountMinor: 90000 });
    const installmentId = await seedInstallment(userId, invoiceId, 1, 45000);
    const otherInstallment = await seedInstallment(userId, invoiceId, 2, 45000);
    const { token, signingSecret } = await seedStripeConnection(userId);

    const a = sessionEvent({
      id: "evt_inst_a",
      metadata: { invoice_id: invoiceId, user_id: userId, installment_id: installmentId },
    });
    const b = sessionEvent({
      id: "evt_inst_b",
      metadata: { invoice_id: invoiceId, user_id: userId, payable_id: otherInstallment },
    });
    await deliver(token, a, signatureFor(a, signingSecret));
    await deliver(token, b, signatureFor(b, signingSecret));

    expect(recordPayment).toHaveBeenNthCalledWith(1, expect.objectContaining({ installmentId }));
    expect(recordPayment).toHaveBeenNthCalledWith(2, expect.objectContaining({ installmentId: otherInstallment }));
  });

  it("refuses a payable that does not belong to the invoice, and leaves the event unrecorded for retry", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId, { invoiceNumber: "INV-A" });
    const { invoiceId: otherInvoice } = await seedClientAndInvoice(userId, { invoiceNumber: "INV-B" });
    const foreignInstallment = await seedInstallment(userId, otherInvoice, 1, 100000);
    const { token, signingSecret } = await seedStripeConnection(userId);

    const payload = sessionEvent({
      id: "evt_foreign",
      metadata: { invoice_id: invoiceId, user_id: userId, installment_id: foreignInstallment },
    });
    await expect(deliver(token, payload, signatureFor(payload, signingSecret))).rejects.toThrow(/does not belong/);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("does not record the event when recordPayment fails, so Stripe's retry processes it", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_crash", metadata: { invoice_id: invoiceId, user_id: userId } });
    const signature = signatureFor(payload, signingSecret);

    vi.mocked(recordPayment).mockRejectedValueOnce(new Error("connection lost"));
    await expect(deliver(token, payload, signature)).rejects.toThrow("connection lost");
    expect(await storedEvents()).toEqual([]);

    const retry = await deliver(token, payload, signature);
    expect(retry.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledTimes(2);
    expect(await storedEvents()).toEqual([{ event_id: "evt_crash", user_id: userId }]);
  });

  it("ignores an unpaid checkout session but records the event against the connection's user", async () => {
    const userId = await createUser("owner@example.test");
    const { invoiceId } = await seedClientAndInvoice(userId);
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({
      id: "evt_unpaid",
      paymentStatus: "unpaid",
      metadata: { invoice_id: invoiceId, user_id: userId },
    });

    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(200);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([{ event_id: "evt_unpaid", user_id: userId }]);
  });

  it("ignores other event types with a 200", async () => {
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = JSON.stringify({
      id: "evt_other",
      object: "event",
      created: CREATED,
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: "pi_1", object: "payment_intent", metadata: {} } },
    });
    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(200);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("ignores a paid session that carries no invoice metadata, such as another product", async () => {
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({ id: "evt_other_product", metadata: { order: "42" } });
    const res = await deliver(token, payload, signatureFor(payload, signingSecret));
    expect(res.status).toBe(200);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("refuses a session whose metadata names another account, even with a valid signature", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    const { invoiceId: otherInvoice } = await seedClientAndInvoice(other);
    const { token, signingSecret } = await seedStripeConnection(owner);
    const payload = sessionEvent({
      id: "evt_wrong_account",
      metadata: { invoice_id: otherInvoice, user_id: other },
    });

    await expect(deliver(token, payload, signatureFor(payload, signingSecret))).rejects.toThrow(/different account/);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await storedEvents()).toEqual([]);
  });

  it("fails loudly on metadata that is ours but malformed", async () => {
    const userId = await createUser("owner@example.test");
    const { token, signingSecret } = await seedStripeConnection(userId);
    const payload = sessionEvent({
      id: "evt_malformed",
      metadata: { invoice_id: "not-a-uuid", user_id: userId },
    });
    await expect(deliver(token, payload, signatureFor(payload, signingSecret))).rejects.toThrow(/malformed/);
    expect(recordPayment).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await closeDb();
});
