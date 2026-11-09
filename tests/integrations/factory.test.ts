/* eslint-disable @typescript-eslint/no-unused-vars -- test fakes mirror the Stripe method signatures */
// Adapter selection. Real database for connected_accounts; no network (Stripe clients are
// constructed but never called, and Resend is only constructed, never sent to).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { authEmailProvider, emailFor, getFakeEmail, paymentsFor } from "@/lib/providers/factory";
import { FakeEmailProvider } from "@/lib/providers/fake";
import { ResendEmailProvider } from "@/lib/providers/resend";
import { StripePaymentProvider } from "@/lib/providers/stripe";

const DUMMY_RESTRICTED_KEY = "rk_test_dummy_not_a_real_key";

// The platform client is replaced by a fake whose calls the tests can read.
const platform = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/providers/stripe-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/stripe-platform")>()),
  platformStripeClient: () => platform.client,
}));

describe("email selection", () => {
  beforeEach(() => {
    getFakeEmail().reset();
  });
  afterEach(() => {
    process.env.SEND_ENABLED = "false";
    delete process.env.RESEND_API_KEY;
  });

  it("returns the shared fake for every user while sending is off", async () => {
    process.env.SEND_ENABLED = "false";
    const a = await emailFor("11111111-1111-4111-8111-111111111111");
    const b = await emailFor("22222222-2222-4222-8222-222222222222");
    expect(a).toBeInstanceOf(FakeEmailProvider);
    expect(a).toBe(b);
    expect(a).toBe(getFakeEmail());
    expect(authEmailProvider()).toBe(getFakeEmail());
  });

  it("records calls on the shared fake so tests can inspect them", async () => {
    process.env.SEND_ENABLED = "false";
    const provider = await emailFor("11111111-1111-4111-8111-111111111111");
    await provider.send({
      from: { name: "Ada", address: "billing@invoices.example.test" },
      replyTo: "ada@studio.example.test",
      to: "client@acme.example.test",
      cc: [],
      subject: "Reminder",
      text: "Hi",
      idempotencyKey: "sm-1",
    });
    expect(getFakeEmail().calls).toHaveLength(1);
  });

  it("uses Resend when SEND_ENABLED is true and the platform key is set", async () => {
    process.env.SEND_ENABLED = "true";
    process.env.RESEND_API_KEY = "re_test_dummy_key";
    const provider = await emailFor("11111111-1111-4111-8111-111111111111");
    expect(provider).toBeInstanceOf(ResendEmailProvider);
    expect(provider.name).toBe("resend");
    expect(authEmailProvider()).toBeInstanceOf(ResendEmailProvider);
  });

  it("fails loudly, and never falls back to the fake, when sending is on without a key", async () => {
    process.env.SEND_ENABLED = "true";
    delete process.env.RESEND_API_KEY;
    await expect(emailFor("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/RESEND_API_KEY/);
    expect(() => authEmailProvider()).toThrow(/RESEND_API_KEY/);
  });
});

describe("paymentsFor", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when the user has no Stripe key connected", async () => {
    const userId = await createUser("owner@example.test");
    expect(await paymentsFor(userId)).toBeNull();
  });

  it("returns a Stripe adapter built from the user's decrypted key", async () => {
    const userId = await createUser("owner@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext, account_label) values ($1, 'stripe', $2, 'acct_test')",
      [userId, encryptSecret(DUMMY_RESTRICTED_KEY)],
    );
    const provider = await paymentsFor(userId);
    expect(provider).toBeInstanceOf(StripePaymentProvider);
  });

  it("does not use a restricted-key connection outside STRIPE_KEY_MODE=restricted", async () => {
    vi.stubEnv("STRIPE_KEY_MODE", "");
    const userId = await createUser("owner@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext) values ($1, 'stripe', $2)",
      [userId, encryptSecret(DUMMY_RESTRICTED_KEY)],
    );
    expect(await paymentsFor(userId)).toBeNull();
  });

  it("acts for an OAuth-connected account through the platform key", async () => {
    const create = vi.fn(async (_params: unknown, _options?: unknown) => ({
      id: "plink_1",
      url: "https://pay.example.test/plink_1",
    }));
    platform.client = { paymentLinks: { create, update: vi.fn(async () => ({})) } };
    const userId = await createUser("owner@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext, account_label) values ($1, 'stripe', null, 'acct_test123')",
      [userId],
    );
    const provider = await paymentsFor(userId);
    expect(provider).toBeInstanceOf(StripePaymentProvider);
    await provider!.createPaymentLink({
      amountMinor: 1000,
      currency: "USD",
      metadata: { payable_id: "11111111-1111-4111-8111-111111111111", invoice_id: "22222222-2222-4222-8222-222222222222", user_id: userId },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ line_items: expect.any(Array) }), {
      stripeAccount: "acct_test123",
    });
  });

  it("never hands one user's Stripe key to another user", async () => {
    const owner = await createUser("owner@example.test");
    const stranger = await createUser("stranger@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext) values ($1, 'stripe', $2)",
      [owner, encryptSecret(DUMMY_RESTRICTED_KEY)],
    );
    expect(await paymentsFor(stranger)).toBeNull();
    expect(await paymentsFor(owner)).toBeInstanceOf(StripePaymentProvider);
  });

  it("ignores a non-Stripe connected account", async () => {
    const userId = await createUser("owner@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext) values ($1, 'gmail', $2)",
      [userId, encryptSecret("oauth-refresh-token")],
    );
    expect(await paymentsFor(userId)).toBeNull();
  });

  it("stores the key only as ciphertext", async () => {
    const userId = await createUser("owner@example.test");
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext) values ($1, 'stripe', $2)",
      [userId, encryptSecret(DUMMY_RESTRICTED_KEY)],
    );
    const { rows } = await adminQuery<{ dump: string }>(
      "select row_to_json(c)::text as dump from connected_accounts c",
    );
    expect(rows[0].dump).not.toContain(DUMMY_RESTRICTED_KEY);
  });
});

afterAll(async () => {
  await closeDb();
});
