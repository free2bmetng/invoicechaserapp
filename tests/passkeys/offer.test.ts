// The add-a-passkey offer: which sign-in raises it, and when the shell shows it.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as verify } from "@/app/auth/verify/route";
import { requestMagicLink } from "@/lib/auth";
import { systemClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import {
  PASSKEY_DISMISSED_COOKIE,
  PASSKEY_OFFER_COOKIE,
  PASSKEY_OFFER_COOKIE_OPTIONS,
  passkeyOfferVisible,
} from "@/lib/passkey-offer";
import { resetPasskeyDb } from "./helpers";

beforeEach(async () => {
  await resetPasskeyDb();
});

afterAll(async () => {
  await closeDb();
});

describe("passkeyOfferVisible", () => {
  it("shows the offer only after a magic-link sign-in, and not once dismissed", () => {
    expect(passkeyOfferVisible("1", undefined)).toBe(true);
    expect(passkeyOfferVisible(undefined, undefined)).toBe(false);
    expect(passkeyOfferVisible("0", undefined)).toBe(false);
    expect(passkeyOfferVisible("1", "1")).toBe(false);
  });
});

describe("magic-link sign-in", () => {
  it("raises the offer for the next page, as an httpOnly cookie that lasts an hour", async () => {
    const { devLink } = await requestMagicLink("offer@example.test", systemClock);
    const response = await verify(new Request(devLink as string));

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${PASSKEY_OFFER_COOKIE}=1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=3600");
    expect(PASSKEY_OFFER_COOKIE_OPTIONS.maxAge).toBe(3600);
    // The session cookie is still set alongside it.
    expect(cookie).toContain("ic_session=");
  });

  it("does not set the dismissal cookie, which is set only by the user", async () => {
    const { devLink } = await requestMagicLink("dismiss@example.test", systemClock);
    const response = await verify(new Request(devLink as string));
    expect(response.headers.get("set-cookie") ?? "").not.toContain(PASSKEY_DISMISSED_COOKIE);
  });
});
