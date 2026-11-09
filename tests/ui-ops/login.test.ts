// Sign-in: the public login action and the verify route. Real database for tokens and
// sessions; no email is sent (SEND_ENABLED is false in the test environment).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as verify } from "@/app/auth/verify/route";
import { requestLoginLink, type LoginState } from "@/app/(auth)/login/actions";
import { closeDb } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";
import { resetDb } from "./fixtures";

const IDLE: LoginState = { status: "idle" };
const ORIGIN = "http://localhost:3000";

function form(email: string): FormData {
  const data = new FormData();
  data.set("email", email);
  return data;
}

function tokenFrom(state: LoginState): string {
  if (state.status !== "sent" || !state.devLink) throw new Error("expected a development link");
  const token = new URL(state.devLink).searchParams.get("token");
  if (!token) throw new Error("dev link has no token");
  return token;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeDb();
});

describe("requestLoginLink", () => {
  it("asks for an email address", async () => {
    await expect(requestLoginLink(IDLE, form(""))).resolves.toEqual({ status: "error", message: "Enter your email address." });
  });

  it("rejects an invalid or oversized address with a calm message", async () => {
    const invalid = { status: "error", message: "Enter a valid email address, such as name@company.com." };
    await expect(requestLoginLink(IDLE, form("not-an-email"))).resolves.toEqual(invalid);
    await expect(requestLoginLink(IDLE, form(`${"a".repeat(260)}@example.test`))).resolves.toEqual(invalid);
  });

  it("issues a link in development, and says that nothing was emailed", async () => {
    const state = await requestLoginLink(IDLE, form("  Owner@Example.TEST "));
    expect(state).toMatchObject({ status: "sent", email: "owner@example.test", sendingOff: true });
    if (state.status !== "sent") throw new Error("expected sent");
    expect(state.devLink).toContain("/auth/verify?token=");
  });

  it("never returns a development link in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const state = await requestLoginLink(IDLE, form("owner@example.test"));
    expect(state).toEqual({ status: "error", message: "Sign-in email is not set up yet. Check the sending settings, then try again." });
    expect(JSON.stringify(state)).not.toContain("devLink");
  });

  it("applies the rate limit: five links per address in ten minutes, then a calm refusal", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await requestLoginLink(IDLE, form("limit@example.test"))).status).toBe("sent");
    }
    expect(await requestLoginLink(IDLE, form("limit@example.test"))).toEqual({
      status: "error",
      message: "Too many sign-in links were requested. Wait a few minutes and try again.",
    });
  });
});

describe("GET /auth/verify", () => {
  it("redirects to /login with the expired code when there is no token", async () => {
    const response = await verify(new Request(`${ORIGIN}/auth/verify`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=expired`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("signs the user in: sets a session cookie and redirects to the dashboard", async () => {
    const token = tokenFrom(await requestLoginLink(IDLE, form("signin@example.test")));
    const response = await verify(new Request(`${ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
  });

  it("treats a used link as expired, so it cannot be replayed", async () => {
    const token = tokenFrom(await requestLoginLink(IDLE, form("replay@example.test")));
    const url = `${ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`;
    expect((await verify(new Request(url))).headers.get("location")).toBe(`${ORIGIN}/`);
    expect((await verify(new Request(url))).headers.get("location")).toBe(`${ORIGIN}/login?error=expired`);
  });

  it("rejects a made-up token with the expired code", async () => {
    const response = await verify(new Request(`${ORIGIN}/auth/verify?token=made-up-token`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=expired`);
  });

  it("never redirects anywhere except this app's home page, whatever the query says", async () => {
    const token = tokenFrom(await requestLoginLink(IDLE, form("redirect@example.test")));
    const response = await verify(
      new Request(`${ORIGIN}/auth/verify?token=${encodeURIComponent(token)}&next=https://evil.example/steal`),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    const bad = await verify(new Request(`${ORIGIN}/auth/verify?next=//evil.example`));
    expect(bad.headers.get("location")).toBe(`${ORIGIN}/login?error=expired`);
  });
});
