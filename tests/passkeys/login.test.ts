// Passkey sign-in: unknown credentials, the counter rule, the compare-and-swap, and the session it creates.
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserId } from "@/lib/auth";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { beginLogin, counterAdvanced, finishLogin, PASSKEY_LOGIN_FAILED, PasskeyLoginError } from "@/lib/passkeys";
import { adminQuery, createUser } from "../helpers/db";
import { assertionFor, insertPasskey, resetPasskeyDb, T0, verifiedAssertion } from "./helpers";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
  };
});

const at = (ms: number) => fixedClock(new Date(Date.parse(T0) + ms).toISOString());

async function counterOf(credentialId: string): Promise<number> {
  const { rows } = await adminQuery<{ counter: string }>("select counter::text as counter from passkeys where credential_id = $1", [
    credentialId,
  ]);
  return Number(rows[0].counter);
}

// Issues a login challenge and returns a response that reaches the counter check, with the library's result mocked.
async function attemptWithCounter(newCounter: number, credentialId = "cred-a") {
  const options = await beginLogin(at(0));
  vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(verifiedAssertion(newCounter, credentialId));
  return finishLogin(assertionFor(options.challenge, credentialId), at(1000));
}

beforeEach(async () => {
  await resetPasskeyDb();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("counterAdvanced", () => {
  it("accepts an increase and allows zero for an authenticator that does not count", () => {
    expect(counterAdvanced(0, 1)).toBe(true);
    expect(counterAdvanced(41, 42)).toBe(true);
    expect(counterAdvanced(0, 0)).toBe(true);
  });

  it("rejects an equal or lower value, including a drop back to zero from a counting key", () => {
    expect(counterAdvanced(5, 5)).toBe(false);
    expect(counterAdvanced(5, 3)).toBe(false);
    expect(counterAdvanced(5, 0)).toBe(false);
  });
});

describe("finishLogin", () => {
  it("refuses an unknown credential with the generic message, and creates no session", async () => {
    await createUser("someone@example.test");
    const options = await beginLogin(at(0));

    const attempt = finishLogin(assertionFor(options.challenge, "cred-nobody-has"), at(1000));
    await expect(attempt).rejects.toBeInstanceOf(PasskeyLoginError);
    await expect(attempt).rejects.toThrow(PASSKEY_LOGIN_FAILED);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect((await adminQuery("select 1 from sessions")).rowCount).toBe(0);
  });

  it("refuses a regressed counter, and leaves the stored counter alone", async () => {
    const userId = await createUser("regress@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 5 });

    await expect(attemptWithCounter(3)).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(await counterOf("cred-a")).toBe(5);
    expect((await adminQuery("select 1 from sessions")).rowCount).toBe(0);
  });

  it("refuses a repeated counter value", async () => {
    const userId = await createUser("repeat@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 5 });

    await expect(attemptWithCounter(5)).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(await counterOf("cred-a")).toBe(5);
  });

  it("accepts zero from an authenticator that does not count", async () => {
    const userId = await createUser("non-counting@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 0 });

    await expect(attemptWithCounter(0)).resolves.toEqual(expect.any(String));
    expect(await counterOf("cred-a")).toBe(0);
  });

  it("advances the counter, stamps last use, and signs the owner in", async () => {
    const userId = await createUser("advance@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 7 });

    const sessionToken = await attemptWithCounter(8);
    expect(await counterOf("cred-a")).toBe(8);
    const { rows } = await adminQuery<{ last_used_at: Date | null }>("select last_used_at from passkeys where credential_id = 'cred-a'");
    expect(rows[0].last_used_at).not.toBeNull();
    expect(await currentUserId(sessionToken, at(2000))).toBe(userId);
  });

  it("refuses when a concurrent sign-in moved the counter first (compare-and-swap)", async () => {
    const userId = await createUser("race@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 5 });
    const options = await beginLogin(at(0));
    // While our verify call is in flight, another sign-in with this passkey lands and moves the counter to 6.
    vi.mocked(verifyAuthenticationResponse).mockImplementationOnce(async () => {
      await adminQuery("update passkeys set counter = 6 where credential_id = 'cred-a'");
      return verifiedAssertion(6);
    });

    await expect(finishLogin(assertionFor(options.challenge), at(1000))).rejects.toBeInstanceOf(PasskeyLoginError);
    expect((await adminQuery("select 1 from sessions")).rowCount).toBe(0);
  });

  it("refuses when the library rejects the signature, with the same generic message", async () => {
    const userId = await createUser("bad-signature@example.test");
    await insertPasskey(userId, { credentialId: "cred-a", counter: 1 });
    const options = await beginLogin(at(0));
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error("signature did not verify"));

    await expect(finishLogin(assertionFor(options.challenge), at(1000))).rejects.toThrow(PASSKEY_LOGIN_FAILED);
    expect(await counterOf("cred-a")).toBe(1);
  });
});
