// Sessions: 90 days from the last use, sliding, and written at most once a day.
// Every use more than a day after the last extension slides the expiry, so each check that needs a
// session to end on time uses its own session.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentUserId, SESSION_REFRESH_AFTER_MS, SESSION_TTL_MS, startSession } from "@/lib/auth";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { SESSION_COOKIE_OPTIONS } from "@/lib/session";
import { adminQuery, createUser } from "../helpers/db";
import { DAY, MINUTE, resetPasskeyDb, T0 } from "./helpers";

const HOUR = 60 * MINUTE;
const START = Date.parse(T0);
const at = (ms: number) => fixedClock(new Date(START + ms).toISOString());

async function expiresAt(sessionToken: string): Promise<number> {
  const idHash = createHash("sha256").update(sessionToken).digest("hex");
  const { rows } = await adminQuery<{ expires_at: Date }>("select expires_at from sessions where id_hash = $1", [idHash]);
  return rows[0].expires_at.getTime();
}

beforeEach(async () => {
  await resetPasskeyDb();
});

afterAll(async () => {
  await closeDb();
});

describe("session lifetime", () => {
  it("is 90 days, and the browser cookie matches it", () => {
    expect(SESSION_TTL_MS).toBe(90 * DAY);
    expect(SESSION_COOKIE_OPTIONS.maxAge).toBe(90 * 24 * 60 * 60);
    expect(SESSION_REFRESH_AFTER_MS).toBe(DAY);
  });

  it("a session that is never used resolves at 89 days and ends at 90 days", async () => {
    const userId = await createUser("ninety@example.test");
    const early = await startSession(userId, at(0));
    const late = await startSession(userId, at(0));

    expect(await currentUserId(early, at(89 * DAY))).toBe(userId);
    expect(await currentUserId(late, at(90 * DAY))).toBeNull();
  });
});

describe("sliding", () => {
  it("a use after a day moves the expiry to 90 days from that use", async () => {
    const userId = await createUser("slide@example.test");
    const token = await startSession(userId, at(0));

    expect(await currentUserId(token, at(60 * DAY))).toBe(userId);
    expect(await expiresAt(token)).toBe(START + 150 * DAY);

    expect(await currentUserId(token, at(149 * DAY))).toBe(userId);
    expect(await expiresAt(token)).toBe(START + 239 * DAY);
  });

  it("ends 90 days after the last use, not 90 days after sign-in", async () => {
    const userId = await createUser("ends@example.test");
    const token = await startSession(userId, at(0));
    expect(await currentUserId(token, at(60 * DAY))).toBe(userId);
    expect(await currentUserId(token, at(149 * DAY))).toBe(userId);

    // 239 days is 90 days after the day-149 use. The session is gone at that moment.
    expect(await currentUserId(token, at(239 * DAY))).toBeNull();
    // Still live at day 150. A session that did not slide would have ended at day 90.
    expect(await currentUserId(token, at(150 * DAY))).toBe(userId);
  });

  it("extends a session created under the old 30-day policy on its first use", async () => {
    const userId = await createUser("legacy@example.test");
    const token = randomBytes(32).toString("base64url");
    await adminQuery("insert into sessions (id_hash, user_id, expires_at, created_at) values ($1, $2, $3, $4)", [
      createHash("sha256").update(token).digest("hex"),
      userId,
      new Date(START + 30 * DAY),
      new Date(START),
    ]);

    expect(await currentUserId(token, at(2 * DAY))).toBe(userId);
    expect(await expiresAt(token)).toBe(START + 2 * DAY + 90 * DAY);
  });
});

describe("write throttle", () => {
  it("uses within a day of the last extension do not write", async () => {
    const userId = await createUser("throttle@example.test");
    const token = await startSession(userId, at(0));
    const original = START + 90 * DAY;

    expect(await currentUserId(token, at(HOUR))).toBe(userId);
    expect(await expiresAt(token)).toBe(original);

    expect(await currentUserId(token, at(23 * HOUR))).toBe(userId);
    expect(await expiresAt(token)).toBe(original);
  });

  it("the first use more than a day after the last extension writes, and the next one within a day does not", async () => {
    const userId = await createUser("throttle-write@example.test");
    const token = await startSession(userId, at(0));

    expect(await currentUserId(token, at(25 * HOUR))).toBe(userId);
    expect(await expiresAt(token)).toBe(START + 25 * HOUR + 90 * DAY);

    expect(await currentUserId(token, at(26 * HOUR))).toBe(userId);
    expect(await expiresAt(token)).toBe(START + 25 * HOUR + 90 * DAY);
  });
});
