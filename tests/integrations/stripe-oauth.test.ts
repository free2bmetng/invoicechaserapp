// Stripe Connect OAuth: the connect and callback routes, the state checks, token storage and
// disconnect. The platform client is replaced by an in-memory fake, so no request leaves the
// process. The database is real.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { TEST_ENV } from "../helpers/env";
import { closeDb } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { connectStripeOAuth, disconnectStripe } from "@/lib/providers/stripe-connection";
import { OAUTH_STATE_COOKIE, StripeOAuthError } from "@/lib/providers/stripe-oauth";
import type { StripePlatformClient } from "@/lib/providers/stripe-platform";
import { SESSION_COOKIE } from "@/lib/session";
import { seedStripeOAuthConnection } from "./fixtures";

const platform = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/providers/stripe-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/stripe-platform")>()),
  platformStripeClient: () => {
    if (!platform.client) throw new Error("no platform client configured for this test");
    return platform.client;
  },
}));

import { GET as connectGET } from "@/app/api/stripe/connect/route";
import { GET as callbackGET } from "@/app/api/stripe/callback/route";

const CLIENT_ID = "ca_test_client";
const STATE = "state-from-the-connect-step";

type Fake = {
  client: unknown;
  tokenCalls: Array<{ grant_type: string; code: string }>;
  deauthorized: Array<{ client_id: string; stripe_user_id: string }>;
};

function fakePlatform(opts: { account?: string; accessToken?: string; tokenFails?: boolean; deauthFails?: boolean } = {}): Fake {
  const fake: Fake = { client: null, tokenCalls: [], deauthorized: [] };
  fake.client = {
    paymentLinks: { create: vi.fn(async () => ({ id: "plink_x", url: "https://pay.example.test/x" })), update: vi.fn(async () => ({})) },
    oauth: {
      token: async (params: { grant_type: "authorization_code"; code: string }) => {
        fake.tokenCalls.push(params);
        if (opts.tokenFails) throw new Error("invalid_grant");
        return { stripe_user_id: opts.account ?? "acct_test123", access_token: opts.accessToken ?? "access-token-xyz", livemode: false };
      },
      deauthorize: async (params: { client_id: string; stripe_user_id: string }) => {
        fake.deauthorized.push(params);
        if (opts.deauthFails) throw new Error("account is not connected");
        return { stripe_user_id: params.stripe_user_id };
      },
    },
  };
  platform.client = fake.client;
  return fake;
}

async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adminQuery(
    "insert into sessions (id_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')",
    [hashToken(token), userId],
  );
  return token;
}

function request(path: string, cookies: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  const url = new URL(path, TEST_ENV.APP_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

function returnedTo(res: Response): URL {
  return new URL(res.headers.get("location") ?? "http://invalid.example");
}

async function accountRows(userId: string) {
  const { rows } = await adminQuery<{
    account_label: string;
    secret_ciphertext: string | null;
    webhook_token: string | null;
    stripe_webhook_endpoint_id: string | null;
  }>(
    `select account_label, secret_ciphertext, webhook_token, stripe_webhook_endpoint_id
       from connected_accounts where user_id = $1 and provider = 'stripe'`,
    [userId],
  );
  return rows;
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", CLIENT_ID);
  platform.client = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/stripe/connect", () => {
  it("requires a session and sets no state cookie without one", async () => {
    const res = await connectGET(request("/api/stripe/connect"));
    expect(res.status).toBe(401);
    expect(setCookie(res, OAUTH_STATE_COOKIE)).toBeUndefined();
  });

  it("redirects to Stripe with the client id, read-write scope, redirect URI and a state, and sets the state cookie", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const res = await connectGET(request("/api/stripe/connect", { [SESSION_COOKIE]: token }));

    expect(res.status).toBe(302);
    const target = returnedTo(res);
    expect(`${target.origin}${target.pathname}`).toBe("https://connect.stripe.com/oauth/authorize");
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("scope")).toBe("read_write");
    expect(target.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/stripe/callback");
    const state = target.searchParams.get("state") ?? "";
    expect(Buffer.from(state, "base64url").length).toBe(32);

    const cookie = setCookie(res, OAUTH_STATE_COOKIE) ?? "";
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=${state};`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/stripe");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toContain("Secure");
  });

  it("gives each visit a new state", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const first = returnedTo(await connectGET(request("/api/stripe/connect", { [SESSION_COOKIE]: token })));
    const second = returnedTo(await connectGET(request("/api/stripe/connect", { [SESSION_COOKIE]: token })));
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
  });

  it("returns 500 when STRIPE_CONNECT_CLIENT_ID is not configured", async () => {
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "");
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const res = await connectGET(request("/api/stripe/connect", { [SESSION_COOKIE]: token }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/stripe/callback", () => {
  async function callback(
    cookies: Record<string, string>,
    query: Record<string, string>,
  ): Promise<Response> {
    return callbackGET(request("/api/stripe/callback", cookies, query));
  }

  it("stores the account id as account_label and no token, clears the state cookie, and returns to settings", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const fake = fakePlatform({ account: "acct_test123" });

    const res = await callback(
      { [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE },
      { code: "ac_code_1", state: STATE },
    );

    expect(res.status).toBe(303);
    expect(returnedTo(res).pathname).toBe("/settings");
    expect(returnedTo(res).searchParams.get("stripe")).toBe("connected");
    expect(setCookie(res, OAUTH_STATE_COOKIE)).toContain("Max-Age=0");
    expect(fake.tokenCalls).toEqual([{ grant_type: "authorization_code", code: "ac_code_1" }]);

    const rows = await accountRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_label).toBe("acct_test123");
    // No token is kept: payments and deauthorize use the platform key and the account id.
    expect(rows[0].secret_ciphertext).toBeNull();
    expect(rows[0].webhook_token).toBeNull();
    expect(rows[0].stripe_webhook_endpoint_id).toBeNull();
  });

  it("refuses without a session, exchanges nothing, and stores nothing", async () => {
    const userId = await createUser("owner@example.test");
    const fake = fakePlatform();
    const res = await callback({ [OAUTH_STATE_COOKIE]: STATE }, { code: "ac_code_1", state: STATE });
    expect(returnedTo(res).searchParams.get("reason")).toBe("signin");
    expect(fake.tokenCalls).toEqual([]);
    expect(await accountRows(userId)).toEqual([]);
  });

  it("refuses a state that does not match the cookie", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const fake = fakePlatform();
    const res = await callback({ [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE }, { code: "ac_code_1", state: "forged" });
    expect(returnedTo(res).searchParams.get("reason")).toBe("state");
    expect(fake.tokenCalls).toEqual([]);
    expect(await accountRows(userId)).toEqual([]);
  });

  it("refuses when the state cookie is missing", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const fake = fakePlatform();
    const res = await callback({ [SESSION_COOKIE]: token }, { code: "ac_code_1", state: STATE });
    expect(returnedTo(res).searchParams.get("reason")).toBe("state");
    expect(fake.tokenCalls).toEqual([]);
  });

  it("reports a denied authorization without exchanging anything", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    const fake = fakePlatform();
    const res = await callback(
      { [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE },
      { error: "access_denied", state: STATE },
    );
    expect(returnedTo(res).searchParams.get("reason")).toBe("denied");
    expect(fake.tokenCalls).toEqual([]);
  });

  it("reports a missing code", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    fakePlatform();
    const res = await callback({ [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE }, { state: STATE });
    expect(returnedTo(res).searchParams.get("reason")).toBe("missing_code");
  });

  it("reports a failed code exchange and stores nothing", async () => {
    const userId = await createUser("owner@example.test");
    const token = await signIn(userId);
    fakePlatform({ tokenFails: true });
    const res = await callback(
      { [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE },
      { code: "ac_expired", state: STATE },
    );
    expect(returnedTo(res).searchParams.get("reason")).toBe("exchange");
    expect(await accountRows(userId)).toEqual([]);
  });

  it("refuses an account another Invoice Chaser account already holds, and leaves that connection alone", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    await seedStripeOAuthConnection(other, "acct_test123");
    const token = await signIn(owner);
    const fake = fakePlatform({ account: "acct_test123" });

    const res = await callback(
      { [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE },
      { code: "ac_code_1", state: STATE },
    );
    expect(returnedTo(res).searchParams.get("reason")).toBe("already_connected");
    expect(await accountRows(owner)).toEqual([]);
    expect((await accountRows(other))[0].account_label).toBe("acct_test123");
    expect(fake.deauthorized).toEqual([]);
  });

  it("deauthorizes the previous account when the user connects a different one", async () => {
    const userId = await createUser("owner@example.test");
    await seedStripeOAuthConnection(userId, "acct_old");
    const token = await signIn(userId);
    const fake = fakePlatform({ account: "acct_new" });

    const res = await callback(
      { [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE },
      { code: "ac_code_2", state: STATE },
    );
    expect(returnedTo(res).searchParams.get("stripe")).toBe("connected");
    expect(fake.deauthorized).toEqual([{ client_id: CLIENT_ID, stripe_user_id: "acct_old" }]);
    expect((await accountRows(userId))[0].account_label).toBe("acct_new");
  });

  it("keeps the account when the user reconnects the same one", async () => {
    const userId = await createUser("owner@example.test");
    await seedStripeOAuthConnection(userId, "acct_test123");
    const token = await signIn(userId);
    const fake = fakePlatform({ account: "acct_test123" });

    await callback({ [SESSION_COOKIE]: token, [OAUTH_STATE_COOKIE]: STATE }, { code: "ac_code_3", state: STATE });
    expect(fake.deauthorized).toEqual([]);
    expect((await accountRows(userId))[0].account_label).toBe("acct_test123");
  });
});

describe("two users racing for one Stripe account", () => {
  it("lets exactly one user win; the other gets already_connected, and the winner's row is intact", async () => {
    const a = await createUser("a@example.test");
    const b = await createUser("b@example.test");
    const fake = fakePlatform({ account: "acct_race" });
    const deps = { platformClient: () => fake.client as StripePlatformClient };

    const results = await Promise.allSettled([
      connectStripeOAuth(a, "code_a", deps),
      connectStripeOAuth(b, "code_b", deps),
    ]);
    const winners = results.map((r, i) => (r.status === "fulfilled" ? [a, b][i] : null)).filter((x) => x !== null);
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBeInstanceOf(StripeOAuthError);
    expect((losers[0].reason as StripeOAuthError).reason).toBe("already_connected");

    const { rows } = await adminQuery<{ user_id: string; account_label: string }>(
      "select user_id, account_label from connected_accounts where account_label = 'acct_race'",
    );
    expect(rows).toEqual([{ user_id: winners[0], account_label: "acct_race" }]);
    expect(fake.deauthorized).toEqual([]);
  });

  it("refuses at insert time when the unique index fires, and leaves the other user's row alone", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    const fake = fakePlatform({ account: "acct_index" });

    // The competing row lands after the duplicate check and before this insert, so the
    // unique index is what refuses this one.
    const attempt = connectStripeOAuth(owner, "code_o", {
      platformClient: () => fake.client as StripePlatformClient,
      afterAccountCheck: async () => {
        await seedStripeOAuthConnection(other, "acct_index");
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(StripeOAuthError);
    await expect(attempt).rejects.toMatchObject({ reason: "already_connected" });

    expect(await accountRows(owner)).toEqual([]);
    expect((await accountRows(other))[0].account_label).toBe("acct_index");
    expect(fake.deauthorized).toEqual([]);
  });
});

describe("disconnectStripe for an OAuth account", () => {
  it("deauthorizes the account, then removes the stored token", async () => {
    const userId = await createUser("owner@example.test");
    await seedStripeOAuthConnection(userId, "acct_test123");
    const fake = fakePlatform();

    const result = await disconnectStripe(userId, { platformClient: () => fake.client as StripePlatformClient });
    expect(result).toEqual({ removed: true, endpointDeleted: true, deauthorized: true });
    expect(fake.deauthorized).toEqual([{ client_id: CLIENT_ID, stripe_user_id: "acct_test123" }]);
    expect(await accountRows(userId)).toEqual([]);
  });

  it("still removes the token when Stripe refuses the deauthorize, and reports it", async () => {
    const userId = await createUser("owner@example.test");
    await seedStripeOAuthConnection(userId, "acct_test123");
    const fake = fakePlatform({ deauthFails: true });

    const result = await disconnectStripe(userId, { platformClient: () => fake.client as StripePlatformClient });
    expect(result).toEqual({ removed: true, endpointDeleted: true, deauthorized: false });
    expect(await accountRows(userId)).toEqual([]);
  });

  it("still removes the token when the platform key is missing, and reports it", async () => {
    const userId = await createUser("owner@example.test");
    await seedStripeOAuthConnection(userId, "acct_test123");
    const result = await disconnectStripe(userId, {
      platformClient: () => {
        throw new Error("STRIPE_SECRET_KEY is not set");
      },
    });
    expect(result).toEqual({ removed: true, endpointDeleted: true, deauthorized: false });
    expect(await accountRows(userId)).toEqual([]);
  });
});

afterAll(async () => {
  await closeDb();
});
