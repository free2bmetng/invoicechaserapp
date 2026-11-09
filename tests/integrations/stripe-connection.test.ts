// Stripe connection helper against the real database, with an injected fake Stripe client.
// No request leaves the process and no real key is used.
import type Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  StripeConnectionClient,
  StripeConnectionError,
  connectStripe,
  disconnectStripe,
  stripeWebhookUrl,
} from "@/lib/providers/stripe-connection";

afterEach(() => {
  vi.unstubAllEnvs();
});

const APP_URL = "https://app.example.test/";
const KEY = "rk_test_abc123WXYZ";

type FakeOptions = {
  listFails?: boolean;
  createFails?: boolean;
  omitSecret?: boolean;
  delFails?: boolean;
  // Ids are we_<startAt+1>, ...; lets two fakes hand out distinct ids.
  startAt?: number;
};

// Records every call in order, so tests can assert that validation precedes creation.
function fakeStripe(opts: FakeOptions = {}) {
  const log: string[] = [];
  const created: Stripe.WebhookEndpointCreateParams[] = [];
  const deleted: string[] = [];
  const keysUsed: string[] = [];
  let seq = opts.startAt ?? 0;
  const client: StripeConnectionClient = {
    webhookEndpoints: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature matches the Stripe method
      async list(_params: Stripe.WebhookEndpointListParams) {
        log.push("list");
        if (opts.listFails) throw new Error("invalid API key");
        return { data: [] };
      },
      async create(params: Stripe.WebhookEndpointCreateParams) {
        log.push("create");
        created.push(params);
        if (opts.createFails) throw new Error("restricted key lacks webhook write permission");
        seq += 1;
        return { id: `we_${seq}`, secret: opts.omitSecret ? undefined : `whsec_${seq}` };
      },
      async del(id: string) {
        log.push("del");
        deleted.push(id);
        if (opts.delFails) throw new Error("endpoint already deleted");
        return { id, deleted: true };
      },
    },
  };
  const deps = {
    createClient: (apiKey: string) => {
      keysUsed.push(apiKey);
      return client;
    },
  };
  return { deps, log, created, deleted, keysUsed };
}

async function connectionRows(userId: string) {
  const { rows } = await adminQuery<{
    secret_ciphertext: string;
    account_label: string;
    webhook_token: string | null;
    webhook_secret_ciphertext: string | null;
    stripe_webhook_endpoint_id: string | null;
  }>(
    `select secret_ciphertext, account_label, webhook_token, webhook_secret_ciphertext,
            stripe_webhook_endpoint_id
       from connected_accounts where user_id = $1 and provider = 'stripe'`,
    [userId],
  );
  return rows;
}

describe("stripeWebhookUrl", () => {
  it("builds the per-connection URL without a doubled slash", () => {
    expect(stripeWebhookUrl("https://app.example.test//", "tok-123")).toBe(
      "https://app.example.test/api/webhooks/stripe/tok-123",
    );
  });
});

describe("connectStripe", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });

  it("validates the key, creates the endpoint, and stores the key and secret encrypted", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe();

    const result = await connectStripe(userId, KEY, APP_URL, fake.deps);
    expect(result).toEqual({ endpointId: "we_1" });

    expect(fake.log).toEqual(["list", "create"]);
    expect(fake.keysUsed).toEqual([KEY]);
    const rows = await connectionRows(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.webhook_token).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(fake.created[0].url).toBe(`https://app.example.test/api/webhooks/stripe/${row.webhook_token}`);
    expect(fake.created[0].enabled_events).toEqual(["checkout.session.completed"]);

    expect(row.stripe_webhook_endpoint_id).toBe("we_1");
    expect(row.account_label).toBe("Restricted key ending WXYZ");
    expect(decryptSecret(row.secret_ciphertext)).toBe(KEY);
    expect(decryptSecret(row.webhook_secret_ciphertext as string)).toBe("whsec_1");
  });

  it("never stores the key or the signing secret as plaintext", async () => {
    const userId = await createUser("owner@example.test");
    await connectStripe(userId, KEY, APP_URL, fakeStripe().deps);
    const { rows } = await adminQuery<{ dump: string }>(
      "select row_to_json(c)::text as dump from connected_accounts c",
    );
    const dump = rows.map((r) => r.dump).join("\n");
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("whsec_1");
  });

  it("refuses a restricted key unless STRIPE_KEY_MODE=restricted, without calling Stripe", async () => {
    vi.stubEnv("STRIPE_KEY_MODE", "");
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe();
    await expect(connectStripe(userId, KEY, APP_URL, fake.deps)).rejects.toBeInstanceOf(StripeConnectionError);
    expect(fake.log).toEqual([]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("rejects a secret key before calling Stripe", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe();
    await expect(connectStripe(userId, "sk_live_full_power", APP_URL, fake.deps)).rejects.toBeInstanceOf(
      StripeConnectionError,
    );
    expect(fake.log).toEqual([]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("rejects a key that Stripe will not accept and stores nothing", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe({ listFails: true });
    await expect(connectStripe(userId, KEY, APP_URL, fake.deps)).rejects.toThrow(/rejected this key/);
    expect(fake.log).toEqual(["list"]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("stores nothing when the key cannot create webhook endpoints", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe({ createFails: true });
    await expect(connectStripe(userId, KEY, APP_URL, fake.deps)).rejects.toThrow(/lacks webhook write/);
    expect(fake.deleted).toEqual([]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("deletes the endpoint and stores nothing when Stripe returns no signing secret", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe({ omitSecret: true });
    await expect(connectStripe(userId, KEY, APP_URL, fake.deps)).rejects.toThrow(/signing secret/);
    expect(fake.deleted).toEqual(["we_1"]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("deletes the new endpoint and rethrows when the token collides and storing fails", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    await connectStripe(other, KEY, APP_URL, fakeStripe().deps);
    const takenToken = (await connectionRows(other))[0].webhook_token as string;

    const userId = await createUser("third@example.test");
    const fake = fakeStripe();
    await expect(
      connectStripe(userId, KEY, APP_URL, { ...fake.deps, newToken: () => takenToken }),
    ).rejects.toThrow();
    expect(fake.deleted).toEqual(["we_1"]);
    expect(await connectionRows(userId)).toEqual([]);
    expect(await connectionRows(owner)).toEqual([]);
  });

  it("replaces an existing connection and deletes the old endpoint", async () => {
    const userId = await createUser("owner@example.test");
    const first = fakeStripe();
    await connectStripe(userId, KEY, APP_URL, first.deps);
    const firstToken = (await connectionRows(userId))[0].webhook_token;

    const second = fakeStripe({ startAt: 1 });
    const result = await connectStripe(userId, "rk_test_second_key_9999", APP_URL, second.deps);
    expect(result).toEqual({ endpointId: "we_2" });

    const rows = await connectionRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].webhook_token).not.toBe(firstToken);
    expect(rows[0].stripe_webhook_endpoint_id).toBe("we_2");
    expect(decryptSecret(rows[0].secret_ciphertext)).toBe("rk_test_second_key_9999");
    // The old endpoint is deleted with the old stored key, through the client for that key.
    expect(second.keysUsed).toEqual(["rk_test_second_key_9999", KEY]);
    expect(second.deleted).toEqual(["we_1"]);
  });
});

describe("disconnectStripe", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });

  it("deletes the endpoint and removes the stored key and secret", async () => {
    const userId = await createUser("owner@example.test");
    await connectStripe(userId, KEY, APP_URL, fakeStripe().deps);

    const fake = fakeStripe();
    const result = await disconnectStripe(userId, fake.deps);
    expect(result).toEqual({ removed: true, endpointDeleted: true, deauthorized: false });
    expect(fake.keysUsed).toEqual([KEY]);
    expect(fake.deleted).toEqual(["we_1"]);
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("still removes the stored key when Stripe refuses the endpoint delete", async () => {
    const userId = await createUser("owner@example.test");
    await connectStripe(userId, KEY, APP_URL, fakeStripe().deps);

    const result = await disconnectStripe(userId, fakeStripe({ delFails: true }).deps);
    expect(result).toEqual({ removed: true, endpointDeleted: false, deauthorized: false });
    expect(await connectionRows(userId)).toEqual([]);
  });

  it("is a no-op when nothing is connected", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakeStripe();
    expect(await disconnectStripe(userId, fake.deps)).toEqual({ removed: false, endpointDeleted: false, deauthorized: false });
    expect(fake.log).toEqual([]);
  });

  it("leaves another user's connection alone", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    await connectStripe(owner, KEY, APP_URL, fakeStripe().deps);
    await connectStripe(other, "rk_test_other_key_1234", APP_URL, fakeStripe().deps);

    await disconnectStripe(owner, fakeStripe().deps);
    expect(await connectionRows(owner)).toEqual([]);
    expect(await connectionRows(other)).toHaveLength(1);
  });
});

afterAll(async () => {
  await closeDb();
});
