// Challenge creation: 20 per client address in 10 minutes, enforced at the limiter and at the route.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginOptions } from "@/app/api/auth/passkey/login/options/route";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { clientAddress } from "@/lib/passkey-http";
import { CHALLENGE_RATE_LIMIT, PASSKEY_RATE_LIMITED, takeChallengeSlot } from "@/lib/passkeys";
import { resetPasskeyDb, T0 } from "./helpers";

const START = Date.parse(T0);
const at = (ms: number) => fixedClock(new Date(START + ms).toISOString());

beforeEach(async () => {
  await resetPasskeyDb();
});

afterAll(async () => {
  await closeDb();
});

describe("takeChallengeSlot", () => {
  it("allows 20 challenges per address in 10 minutes, then refuses", () => {
    const address = "198.51.100.1";
    for (let i = 0; i < CHALLENGE_RATE_LIMIT.max; i += 1) {
      expect(takeChallengeSlot(address, at(i * 1000))).toBe(true);
    }
    expect(takeChallengeSlot(address, at(30 * 1000))).toBe(false);
  });

  it("counts each address on its own", () => {
    const busy = "198.51.100.2";
    const quiet = "198.51.100.3";
    for (let i = 0; i < CHALLENGE_RATE_LIMIT.max; i += 1) takeChallengeSlot(busy, at(0));
    expect(takeChallengeSlot(busy, at(0))).toBe(false);
    expect(takeChallengeSlot(quiet, at(0))).toBe(true);
  });

  it("frees a slot once the earliest challenge is more than 10 minutes old", () => {
    const address = "198.51.100.4";
    for (let i = 0; i < CHALLENGE_RATE_LIMIT.max; i += 1) takeChallengeSlot(address, at(0));
    expect(takeChallengeSlot(address, at(10 * 60 * 1000 - 1))).toBe(false);
    expect(takeChallengeSlot(address, at(10 * 60 * 1000))).toBe(true);
  });
});

describe("clientAddress", () => {
  it("uses the last X-Forwarded-For entry, the one the platform appended", () => {
    const request = new Request("http://localhost:3000/", {
      headers: { "x-forwarded-for": "10.0.0.66, 203.0.113.9" },
    });
    expect(clientAddress(request)).toBe("203.0.113.9");
  });

  it("falls back to X-Real-IP, then to a shared 'unknown' bucket", () => {
    expect(clientAddress(new Request("http://localhost:3000/", { headers: { "x-real-ip": " 192.0.2.7 " } }))).toBe("192.0.2.7");
    expect(clientAddress(new Request("http://localhost:3000/"))).toBe("unknown");
  });
});

describe("POST /api/auth/passkey/login/options", () => {
  it("answers 429 with the generic message on the 21st request from one address", async () => {
    const headers = { "x-forwarded-for": "203.0.113.50", "content-type": "application/json" };
    for (let i = 0; i < CHALLENGE_RATE_LIMIT.max; i += 1) {
      const response = await loginOptions(new Request("http://localhost:3000/api/auth/passkey/login/options", { method: "POST", headers }));
      expect(response.status).toBe(200);
    }
    const refused = await loginOptions(new Request("http://localhost:3000/api/auth/passkey/login/options", { method: "POST", headers }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: PASSKEY_RATE_LIMITED });
  });

  it("does not let one address's requests count against another", async () => {
    const other = await loginOptions(
      new Request("http://localhost:3000/api/auth/passkey/login/options", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.51" },
      }),
    );
    expect(other.status).toBe(200);
  });
});
