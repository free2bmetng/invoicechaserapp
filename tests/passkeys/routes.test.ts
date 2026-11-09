// The passkey route handlers, called directly. Session reads are mocked so each test chooses who is signed in.
// No authenticator is simulated; success paths mock the library's verify call.
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as loginOptions } from "@/app/api/auth/passkey/login/options/route";
import { POST as loginVerify } from "@/app/api/auth/passkey/login/verify/route";
import { POST as registerOptions } from "@/app/api/auth/passkey/register/options/route";
import { POST as registerVerify } from "@/app/api/auth/passkey/register/verify/route";
import { closeDb } from "@/lib/db";
import { PASSKEY_LOGIN_FAILED, PASSKEY_SAVE_FAILED } from "@/lib/passkeys";
import { getUserId } from "@/lib/session";
import { adminQuery, createUser } from "../helpers/db";
import {
  assertionFor,
  attestationFor,
  challengeRows,
  insertPasskey,
  resetPasskeyDb,
  verifiedAssertion,
  verifiedAttestation,
} from "./helpers";

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, getUserId: vi.fn(async () => null) };
});

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
  };
});

const BASE = "http://localhost:3000/api/auth/passkey";
let ipCounter = 0;

// Each test uses its own client address, so the challenge rate limit never interferes across tests.
function ip(): string {
  ipCounter += 1;
  return `192.0.2.${ipCounter}`;
}

function post(path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": ip(), ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sessionCount(): Promise<number> {
  return (await adminQuery("select 1 from sessions")).rowCount ?? 0;
}

beforeEach(async () => {
  await resetPasskeyDb();
  vi.clearAllMocks();
  vi.mocked(getUserId).mockResolvedValue(null);
});

afterAll(async () => {
  await closeDb();
});

describe("POST login/options", () => {
  it("returns discoverable-credential options with user verification and no-store caching", async () => {
    const response = await loginOptions(post("login/options"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { challenge: string; rpId: string; userVerification: string; allowCredentials?: unknown[] };
    expect(body.rpId).toBe("localhost");
    expect(body.userVerification).toBe("required");
    expect(body.allowCredentials).toBeUndefined();
    expect(await challengeRows(body.challenge)).toEqual([expect.objectContaining({ purpose: "login", user_id: null })]);
  });
});

describe("POST login/verify", () => {
  it("refuses a request that is not JSON, with the generic message", async () => {
    const request = new Request(`${BASE}/login/verify`, { method: "POST", headers: { "x-forwarded-for": ip() }, body: "response=x" });
    const response = await loginVerify(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PASSKEY_LOGIN_FAILED });
  });

  it("refuses a body without a response object", async () => {
    const response = await loginVerify(post("login/verify", { nope: true }));
    expect(response.status).toBe(400);
  });

  it("refuses an unknown credential with 401 and the generic message, and sets no cookie", async () => {
    const options = await (await loginOptions(post("login/options"))).json();
    const response = await loginVerify(post("login/verify", { response: assertionFor(options.challenge, "cred-unknown") }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: PASSKEY_LOGIN_FAILED });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await sessionCount()).toBe(0);
  });

  it("signs in with a verified passkey: sets the session cookie with the configured attributes", async () => {
    const userId = await createUser("route-login@example.test");
    await insertPasskey(userId, { credentialId: "cred-route" });
    const options = await (await loginOptions(post("login/options"))).json();
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(verifiedAssertion(1, "cred-route"));

    const response = await loginVerify(post("login/verify", { response: assertionFor(options.challenge, "cred-route") }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ic_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
    // Passkey sign-in does not raise the add-a-passkey offer.
    expect(cookie).not.toContain("ic_passkey_offer");
    expect(await sessionCount()).toBe(1);
  });
});

describe("register routes require a session", () => {
  it("register/options answers 401 without a session, and creates no challenge", async () => {
    const response = await registerOptions(post("register/options"));
    expect(response.status).toBe(401);
    expect((await adminQuery("select 1 from webauthn_challenges")).rowCount).toBe(0);
  });

  it("register/verify answers 401 without a session, and stores nothing", async () => {
    const response = await registerVerify(post("register/verify", { response: attestationFor("anything"), label: "Phone" }));
    expect(response.status).toBe(401);
    expect((await adminQuery("select 1 from passkeys")).rowCount).toBe(0);
  });

  it("register/options for a signed-in user excludes that user's passkeys", async () => {
    const userId = await createUser("route-reg@example.test");
    await insertPasskey(userId, { credentialId: "cred-existing" });
    vi.mocked(getUserId).mockResolvedValue(userId);

    const response = await registerOptions(post("register/options"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(["cred-existing"]);
  });

  it("register/verify for a signed-in user stores the passkey and returns its id and label", async () => {
    const userId = await createUser("route-store@example.test");
    vi.mocked(getUserId).mockResolvedValue(userId);
    const options = await (await registerOptions(post("register/options"))).json();
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-phone", new Uint8Array([5, 6]), 0));

    const response = await registerVerify(post("register/verify", { response: attestationFor(options.challenge, "cred-phone"), label: "Pixel" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, passkey: { id: expect.any(String), label: "Pixel" } });
  });

  it("register/verify refuses a malformed response with the generic message", async () => {
    const userId = await createUser("route-bad@example.test");
    vi.mocked(getUserId).mockResolvedValue(userId);

    const response = await registerVerify(post("register/verify", { response: { id: "x" }, label: "Phone" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PASSKEY_SAVE_FAILED });
  });
});
