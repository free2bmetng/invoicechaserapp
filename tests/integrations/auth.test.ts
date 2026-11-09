// Magic-link sign-in against the real database: single use, expiry, rate limit, sessions.
// provisionUser (engine) and the email provider are mocked. Tokens are checked by hash.
import { createHash } from "node:crypto";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { fixedClock } from "@/lib/clock";

type SentEmail = { to: string; subject: string; text: string; idempotencyKey: string };

const sent = vi.hoisted(() => [] as SentEmail[]);

vi.mock("@/lib/providers/factory", () => ({
  authEmailProvider: () => ({
    name: "fake",
    send: async (email: SentEmail) => {
      sent.push(email);
      return { providerMessageId: `fake_${sent.length}` };
    },
  }),
}));

vi.mock("@/lib/engine", () => ({
  provisionUser: vi.fn(async () => undefined),
}));

import {
  AuthNotConfiguredError,
  InvalidEmailError,
  LoginLinkInvalidError,
  LoginRateLimitedError,
  SESSION_TTL_MS,
  consumeMagicLink,
  currentUserId,
  endSession,
  requestMagicLink,
  startSession,
} from "@/lib/auth";
import { provisionUser } from "@/lib/engine";

const T0 = "2026-11-09T09:00:00.000Z";
const MINUTE = 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function tokenFromDevLink(devLink: string): string {
  const token = new URL(devLink).searchParams.get("token");
  if (!token) throw new Error("dev link has no token");
  return token;
}

async function tokenRows(email: string) {
  const { rows } = await adminQuery<{ token_hash: string; expires_at: Date; used_at: Date | null; created_at: Date }>(
    "select token_hash, expires_at, used_at, created_at from login_tokens where email = $1 order by created_at",
    [email],
  );
  return rows;
}

describe("requestMagicLink in development", () => {
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a dev link under APP_URL and stores only the hash of the token", async () => {
    const clock = fixedClock(T0);
    const { devLink } = await requestMagicLink("Ada@Example.TEST", clock);

    expect(devLink).toBeDefined();
    const link = new URL(devLink as string);
    expect(link.origin + link.pathname).toBe("http://localhost:3000/auth/verify");
    const token = tokenFromDevLink(devLink as string);

    const rows = await tokenRows("ada@example.test");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha256(token));
    expect(rows[0].token_hash).not.toBe(token);

    // The raw token appears nowhere in the table.
    const dump = await adminQuery<{ dump: string }>(
      "select row_to_json(t)::text as dump from login_tokens t",
    );
    expect(dump.rows.map((r) => r.dump).join("\n")).not.toContain(token);
  });

  it("sets the link to expire 15 minutes after the request", async () => {
    const clock = fixedClock(T0);
    await requestMagicLink("ada@example.test", clock);
    const [row] = await tokenRows("ada@example.test");
    expect(row.expires_at.toISOString()).toBe(new Date(Date.parse(T0) + 15 * MINUTE).toISOString());
  });

  it("sends no email while sending is off", async () => {
    await requestMagicLink("ada@example.test", fixedClock(T0));
    expect(sent).toHaveLength(0);
  });

  it("refuses to issue a link in production while sending is off, so no link is ever handed out", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(requestMagicLink("ada@example.test", fixedClock(T0))).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
    expect(await tokenRows("ada@example.test")).toHaveLength(0);
  });

  it("rejects a malformed address without storing a token", async () => {
    await expect(requestMagicLink("not-an-email", fixedClock(T0))).rejects.toBeInstanceOf(InvalidEmailError);
    expect(await tokenRows("not-an-email")).toHaveLength(0);
  });
});

describe("consumeMagicLink", () => {
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    vi.clearAllMocks();
  });

  it("signs the user in, creating the user row, and stores only the session hash", async () => {
    const clock = fixedClock(T0);
    const { devLink } = await requestMagicLink("Ada@Example.test", clock);
    const { sessionToken, userId } = await consumeMagicLink(tokenFromDevLink(devLink as string), clock);

    const users = await adminQuery<{ id: string; email: string }>("select id, email from users");
    expect(users.rows).toEqual([{ id: userId, email: "ada@example.test" }]);
    expect(provisionUser).toHaveBeenCalledWith(userId, expect.anything());

    const sessions = await adminQuery<{ id_hash: string; user_id: string }>(
      "select id_hash, user_id from sessions",
    );
    expect(sessions.rows).toEqual([{ id_hash: sha256(sessionToken), user_id: userId }]);
    expect(sessionToken).not.toBe(sha256(sessionToken));
  });

  it("accepts a link once and rejects reuse", async () => {
    const clock = fixedClock(T0);
    const { devLink } = await requestMagicLink("ada@example.test", clock);
    const token = tokenFromDevLink(devLink as string);

    await consumeMagicLink(token, clock);
    await expect(consumeMagicLink(token, clock)).rejects.toBeInstanceOf(LoginLinkInvalidError);
  });

  it("lets two simultaneous uses of one link race, with exactly one winner", async () => {
    const clock = fixedClock(T0);
    const { devLink } = await requestMagicLink("ada@example.test", clock);
    const token = tokenFromDevLink(devLink as string);

    const results = await Promise.allSettled([
      consumeMagicLink(token, clock),
      consumeMagicLink(token, clock),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(LoginLinkInvalidError);
    expect(await adminQuery("select 1 from sessions")).toMatchObject({ rowCount: 1 });
  });

  it("accepts a link just before its 15-minute expiry", async () => {
    const issued = fixedClock(T0);
    const { devLink } = await requestMagicLink("ada@example.test", issued);
    const later = fixedClock(new Date(Date.parse(T0) + 15 * MINUTE - 1_000).toISOString());
    await expect(consumeMagicLink(tokenFromDevLink(devLink as string), later)).resolves.toMatchObject({
      userId: expect.any(String),
    });
  });

  it("rejects a link at exactly its expiry instant", async () => {
    const issued = fixedClock(T0);
    const { devLink } = await requestMagicLink("ada@example.test", issued);
    const atExpiry = fixedClock(new Date(Date.parse(T0) + 15 * MINUTE).toISOString());
    await expect(consumeMagicLink(tokenFromDevLink(devLink as string), atExpiry)).rejects.toBeInstanceOf(
      LoginLinkInvalidError,
    );
  });

  it("rejects an expired link and does not create a user", async () => {
    const issued = fixedClock(T0);
    const { devLink } = await requestMagicLink("ada@example.test", issued);
    const late = fixedClock(new Date(Date.parse(T0) + 16 * MINUTE).toISOString());
    await expect(consumeMagicLink(tokenFromDevLink(devLink as string), late)).rejects.toBeInstanceOf(
      LoginLinkInvalidError,
    );
    expect(await adminQuery("select 1 from users")).toMatchObject({ rowCount: 0 });
    expect(await adminQuery("select 1 from sessions")).toMatchObject({ rowCount: 0 });
  });

  it("rejects unknown, empty and oversized tokens", async () => {
    const clock = fixedClock(T0);
    await expect(consumeMagicLink("never-issued", clock)).rejects.toBeInstanceOf(LoginLinkInvalidError);
    await expect(consumeMagicLink("", clock)).rejects.toBeInstanceOf(LoginLinkInvalidError);
    await expect(consumeMagicLink("x".repeat(5000), clock)).rejects.toBeInstanceOf(LoginLinkInvalidError);
  });

  it("reuses the existing user row for a returning address", async () => {
    const existing = await createUser("ada@example.test");
    const clock = fixedClock(T0);
    const { devLink } = await requestMagicLink("ADA@example.test", clock);
    const { userId } = await consumeMagicLink(tokenFromDevLink(devLink as string), clock);
    expect(userId).toBe(existing);
    expect(await adminQuery("select 1 from users")).toMatchObject({ rowCount: 1 });
  });
});

describe("requestMagicLink rate limit", () => {
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    vi.clearAllMocks();
  });

  it("allows 5 requests per address in 10 minutes and rejects the 6th", async () => {
    const clock = fixedClock(T0);
    for (let i = 0; i < 5; i++) {
      await expect(requestMagicLink("ada@example.test", clock)).resolves.toMatchObject({
        devLink: expect.stringContaining("/auth/verify?token="),
      });
    }
    await expect(requestMagicLink("ada@example.test", clock)).rejects.toBeInstanceOf(LoginRateLimitedError);
    expect(await tokenRows("ada@example.test")).toHaveLength(5);
  });

  it("counts case and surrounding whitespace as the same address", async () => {
    const clock = fixedClock(T0);
    for (let i = 0; i < 5; i++) {
      await requestMagicLink(i % 2 === 0 ? "ADA@example.test" : "  ada@Example.test ", clock);
    }
    await expect(requestMagicLink("ada@example.test", clock)).rejects.toBeInstanceOf(LoginRateLimitedError);
  });

  it("does not limit other addresses", async () => {
    const clock = fixedClock(T0);
    for (let i = 0; i < 5; i++) await requestMagicLink("ada@example.test", clock);
    await expect(requestMagicLink("bob@example.test", clock)).resolves.toMatchObject({
      devLink: expect.any(String),
    });
  });

  it("allows requests again once the 10-minute window has passed", async () => {
    for (let i = 0; i < 5; i++) await requestMagicLink("ada@example.test", fixedClock(T0));
    const later = fixedClock(new Date(Date.parse(T0) + 10 * MINUTE + 1).toISOString());
    await expect(requestMagicLink("ada@example.test", later)).resolves.toMatchObject({
      devLink: expect.any(String),
    });
  });

  it("holds to the limit when ten requests arrive at once", async () => {
    const clock = fixedClock(T0);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => requestMagicLink("ada@example.test", clock)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.every((r) => r.reason instanceof LoginRateLimitedError)).toBe(true);
    expect(await tokenRows("ada@example.test")).toHaveLength(5);
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
  });

  async function signIn(email = "ada@example.test", clock = fixedClock(T0)) {
    const { devLink } = await requestMagicLink(email, clock);
    return consumeMagicLink(tokenFromDevLink(devLink as string), clock);
  }

  it("resolves a live session token to its user", async () => {
    const { sessionToken, userId } = await signIn();
    expect(await currentUserId(sessionToken, fixedClock(T0))).toBe(userId);
  });

  it("returns null for missing, unknown and empty session tokens", async () => {
    await signIn();
    const clock = fixedClock(T0);
    expect(await currentUserId(undefined, clock)).toBeNull();
    expect(await currentUserId("", clock)).toBeNull();
    expect(await currentUserId("not-a-session", clock)).toBeNull();
  });

  it("stops resolving 90 days after its last use, and still resolves just before that", async () => {
    // Two sessions, because a use near the end slides that session forward. An unused session expires on time.
    const { userId } = await signIn();
    const unused = await startSession(userId, fixedClock(T0));
    const used = await startSession(userId, fixedClock(T0));
    const almost = fixedClock(new Date(Date.parse(T0) + SESSION_TTL_MS - 1_000).toISOString());
    const expired = fixedClock(new Date(Date.parse(T0) + SESSION_TTL_MS).toISOString());
    expect(await currentUserId(used, almost)).toBe(userId);
    expect(await currentUserId(unused, expired)).toBeNull();
  });

  it("ends a session so that it no longer resolves", async () => {
    const { sessionToken } = await signIn();
    await endSession(sessionToken);
    expect(await currentUserId(sessionToken, fixedClock(T0))).toBeNull();
    expect(await adminQuery("select 1 from sessions")).toMatchObject({ rowCount: 0 });
  });

  it("treats ending an unknown or empty session as a no-op", async () => {
    await signIn();
    await expect(endSession("not-a-session")).resolves.toBeUndefined();
    await expect(endSession("")).resolves.toBeUndefined();
    expect(await adminQuery("select 1 from sessions")).toMatchObject({ rowCount: 1 });
  });
});

describe("sending on", () => {
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    vi.clearAllMocks();
    vi.stubEnv("SEND_ENABLED", "true");
    vi.stubEnv("AUTH_EMAIL_FROM", "support@invoices.example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emails the link through the provider and returns no dev link", async () => {
    const clock = fixedClock(T0);
    const result = await requestMagicLink("ada@example.test", clock);
    expect(result).toEqual({});

    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email.to).toBe("ada@example.test");
    expect(email.subject).toMatch(/sign-in/i);
    const match = email.text.match(/https?:\/\/\S+/);
    expect(match).not.toBeNull();
    const token = tokenFromDevLink(match![0]);
    expect(email.idempotencyKey).toBe(`login:${sha256(token)}`);

    // The emailed token is the one that gets stored, as a hash.
    const rows = await tokenRows("ada@example.test");
    expect(rows[0].token_hash).toBe(sha256(token));
    await expect(consumeMagicLink(token, clock)).resolves.toMatchObject({ userId: expect.any(String) });
  });

  it("refuses to send when AUTH_EMAIL_FROM is missing, and stores no token", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    await expect(requestMagicLink("ada@example.test", fixedClock(T0))).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
    expect(sent).toHaveLength(0);
    expect(await tokenRows("ada@example.test")).toHaveLength(0);
  });
});

afterAll(async () => {
  await closeDb();
});
