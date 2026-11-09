// Settings data layer against the real database. Stripe is always the injected fake.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb, withUser } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  SettingsConfigError,
  connectStripeFor,
  disconnectStripeFor,
  getSettingsView,
  markSequenceReviewed,
  onboardingSteps,
  saveProfileAndSettings,
  saveSendingDomain,
} from "@/lib/queries/settings";
import { StripeConnectionError } from "@/lib/providers/stripe-connection";
import { clockAt, connectionCount, fakeStripe, NOW, seedStripeConnection, setupOwner, addInvoice } from "./fixtures";

const KEY = "rk_live_SECRETVALUE_0042";

// The sender section in one value. Tests override the fields they check.
const PROFILE = {
  senderName: "Alice Smith",
  businessName: "Smith Books",
  postalAddress: "2 Quay Street",
  timezone: "UTC",
  windowStart: 9,
  windowEnd: 17,
  dailyCap: 20,
  digestEnabled: true,
  digestHour: 8,
};

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("saves write only the signed-in user's row", () => {
  it("writes the sender section and leaves another user's settings alone", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    await saveProfileAndSettings(alice.userId, PROFILE, clockAt());

    const aliceView = await getSettingsView(alice.userId);
    const bobView = await getSettingsView(bob.userId);
    expect(aliceView.settings.senderName).toBe("Alice Smith");
    expect(aliceView.settings.businessName).toBe("Smith Books");
    expect(bobView.settings.senderName).toBe("Ada Lovelace");
  });

  it("writes every field of the sender section, and the sending domain separately", async () => {
    const owner = await setupOwner();
    const clock = clockAt();
    await saveProfileAndSettings(
      owner.userId,
      { ...PROFILE, timezone: "Europe/London", windowStart: 10, windowEnd: 16, dailyCap: 75, digestEnabled: false, digestHour: 7 },
      clock,
    );
    await saveSendingDomain(owner.userId, "mail.example.test", clock);

    const view = await getSettingsView(owner.userId);
    expect(view.settings).toMatchObject({
      senderName: "Alice Smith",
      timezone: "Europe/London",
      sendWindowStart: 10,
      sendWindowEnd: 16,
      dailyCap: 75,
      digestEnabled: false,
      digestHour: 7,
      sendingDomain: "mail.example.test",
    });
  });

  it("writes the whole onboarding step 1 in one save", async () => {
    const owner = await setupOwner({ profile: false, domain: null });
    await saveProfileAndSettings(
      owner.userId,
      {
        senderName: "Ada",
        businessName: "Ada Studio",
        postalAddress: "1 Main St",
        timezone: "America/New_York",
        windowStart: 9,
        windowEnd: 13,
        dailyCap: 40,
        digestEnabled: true,
        digestHour: 6,
      },
      clockAt(),
    );
    const view = await getSettingsView(owner.userId);
    expect(view.settings).toMatchObject({
      senderName: "Ada",
      businessName: "Ada Studio",
      postalAddress: "1 Main St",
      timezone: "America/New_York",
      sendWindowStart: 9,
      sendWindowEnd: 13,
      dailyCap: 40,
      digestEnabled: true,
      digestHour: 6,
    });
  });

  it("creates the settings row when it is missing, rather than failing silently", async () => {
    const userId = await createUser("late-row@example.test");
    await saveProfileAndSettings(userId, { ...PROFILE, dailyCap: 33 }, clockAt());
    const view = await getSettingsView(userId);
    expect(view.settings.dailyCap).toBe(33);
  });
});

describe("row-level security", () => {
  it("blocks a request-role update of another user's settings", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    const updated = await withUser(alice.userId, async (c) => {
      const result = await c.query("update settings set daily_cap = 1 where user_id = $1", [bob.userId]);
      return result.rowCount;
    });
    expect(updated).toBe(0);
    const { rows } = await adminQuery<{ daily_cap: number }>("select daily_cap from settings where user_id = $1", [bob.userId]);
    expect(rows[0].daily_cap).toBe(20);
  });
});

describe("the view", () => {
  it("reports the default sequence steps in send order and never the Stripe key", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId, KEY);
    const view = await getSettingsView(owner.userId);

    expect(view.steps.map((s) => s.offsetDays)).toEqual([-3, 0, 7, 14]);
    expect(view.stripe).toEqual({ connected: true, accountLabel: "Restricted key ending 0042" });
    expect(JSON.stringify(view)).not.toContain("SECRETVALUE");
    expect(JSON.stringify(view)).not.toContain("rk_live");
  });

  it("reports Stripe setup from the environment, and never a token or a key", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId, KEY);
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_client");
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
    try {
      const view = await getSettingsView(owner.userId);
      expect(view.stripeOauthConfigured).toBe(true);
      expect(view.stripeRestrictedKeyMode).toBe(true);
      expect(JSON.stringify(view)).not.toContain("SECRETVALUE");
      expect(JSON.stringify(view)).not.toContain("ca_test_client");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "");
    vi.stubEnv("STRIPE_KEY_MODE", "oauth");
    try {
      const view = await getSettingsView(owner.userId);
      expect(view.stripeOauthConfigured).toBe(false);
      expect(view.stripeRestrictedKeyMode).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts the user's invoices", async () => {
    const owner = await setupOwner();
    await addInvoice(owner.userId);
    await addInvoice(owner.userId);
    expect((await getSettingsView(owner.userId)).invoiceCount).toBe(2);
  });
});

describe("Stripe connection through the data layer", () => {
  it("refuses to connect when APP_URL is not set, before any Stripe call or write", async () => {
    const owner = await setupOwner();
    const stripe = fakeStripe();
    await expect(connectStripeFor(owner.userId, KEY, { appUrl: undefined, stripe: stripe.deps })).rejects.toBeInstanceOf(
      SettingsConfigError,
    );
    expect(stripe.created).toHaveLength(0);
    expect(stripe.listCalls).toBe(0);
    expect(await connectionCount(owner.userId)).toBe(0);
  });

  it("stores the key encrypted and exposes only the label", async () => {
    // Pasting a restricted key is refused unless the installation is in restricted mode. Set it for this
    // test only, and restore the environment afterwards.
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
    try {
      const owner = await setupOwner();
      const stripe = fakeStripe();
      await connectStripeFor(owner.userId, KEY, { appUrl: "https://app.example.test", stripe: stripe.deps });

      const { rows } = await adminQuery<{ secret_ciphertext: string; account_label: string }>(
        "select secret_ciphertext, account_label from connected_accounts where user_id = $1",
        [owner.userId],
      );
      expect(rows[0].secret_ciphertext).not.toContain("SECRETVALUE");
      expect(rows[0].secret_ciphertext).not.toContain(KEY);
      expect(decryptSecret(rows[0].secret_ciphertext)).toBe(KEY);
      expect(rows[0].account_label).toBe("Restricted key ending 0042");
      expect(stripe.created[0].url).toEqual(expect.stringContaining("https://app.example.test/api/webhooks/stripe/"));
      expect(stripe.keysUsed).toEqual([KEY]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes Stripe's refusal through as a StripeConnectionError and stores nothing", async () => {
    const owner = await setupOwner();
    const stripe = fakeStripe({ createFails: true });
    await expect(connectStripeFor(owner.userId, KEY, { appUrl: "https://app.example.test", stripe: stripe.deps })).rejects.toBeInstanceOf(
      StripeConnectionError,
    );
    expect(await connectionCount(owner.userId)).toBe(0);
  });

  it("disconnects, deletes the endpoint and removes the stored key", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId, KEY);
    const stripe = fakeStripe();
    const result = await disconnectStripeFor(owner.userId, { stripe: stripe.deps });
    // The seeded connection has no OAuth account, so nothing was deauthorized.
    expect(result).toEqual({ removed: true, endpointDeleted: true, deauthorized: false });
    expect(stripe.deleted).toEqual(["we_seeded"]);
    expect(await connectionCount(owner.userId)).toBe(0);
  });

  it("reports endpointDeleted:false when Stripe will not delete the endpoint, and still removes the key", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId, KEY);
    const stripe = fakeStripe({ endpointDeleteFails: true });
    const result = await disconnectStripeFor(owner.userId, { stripe: stripe.deps });
    expect(result).toEqual({ removed: true, endpointDeleted: false, deauthorized: false });
    expect(await connectionCount(owner.userId)).toBe(0);
  });

  it("reports removed:false when nothing is connected", async () => {
    const owner = await setupOwner();
    const stripe = fakeStripe();
    expect(await disconnectStripeFor(owner.userId, { stripe: stripe.deps })).toEqual({
      removed: false,
      endpointDeleted: false,
      deauthorized: false,
    });
    expect(stripe.deleted).toHaveLength(0);
  });
});

describe("onboarding review", () => {
  it("records the review once however many times it is confirmed", async () => {
    const owner = await setupOwner();
    await markSequenceReviewed(owner.userId, clockAt(NOW));
    await markSequenceReviewed(owner.userId, clockAt(NOW));
    const { rows } = await adminQuery<{ n: string }>(
      "select count(*)::text as n from events where user_id = $1 and type = 'onboarding_sequence_reviewed'",
      [owner.userId],
    );
    expect(rows[0].n).toBe("1");
    expect((await getSettingsView(owner.userId)).sequenceReviewed).toBe(true);
  });

  it("treats invoices as optional and the other three steps as required", async () => {
    const owner = await setupOwner({ profile: false, domain: null });
    const steps = onboardingSteps(await getSettingsView(owner.userId));
    expect(steps.map((s) => [s.key, s.done, s.required])).toEqual([
      ["profile", false, true],
      ["sending", false, true],
      ["invoices", false, false],
      ["review", false, true],
    ]);
  });
});
