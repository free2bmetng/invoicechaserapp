// Challenges: single use, five-minute expiry, and the binding of purpose and user.
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import {
  beginLogin,
  beginRegistration,
  CHALLENGE_TTL_MS,
  finishLogin,
  finishRegistration,
  PasskeyLoginError,
  PasskeyRegistrationError,
} from "@/lib/passkeys";
import { adminQuery, createUser } from "../helpers/db";
import {
  assertionFor,
  attestationFor,
  DAY,
  insertPasskey,
  MINUTE,
  resetPasskeyDb,
  T0,
  verifiedAssertion,
  verifiedAttestation,
} from "./helpers";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
  };
});

const at = (ms: number) => fixedClock(new Date(Date.parse(T0) + ms).toISOString());

beforeEach(async () => {
  await resetPasskeyDb();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("login challenges", () => {
  it("is single use: the same signed challenge cannot sign in twice", async () => {
    const userId = await createUser("single@example.test");
    await insertPasskey(userId, { credentialId: "cred-a" });
    const options = await beginLogin(at(0));
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(verifiedAssertion(1));
    const response = assertionFor(options.challenge);

    await expect(finishLogin(response, at(10 * 1000))).resolves.toEqual(expect.any(String));
    await expect(finishLogin(response, at(20 * 1000))).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it("expires five minutes after it was issued, and is refused before any cryptographic check", async () => {
    const userId = await createUser("expiry@example.test");
    await insertPasskey(userId, { credentialId: "cred-a" });
    const options = await beginLogin(at(0));
    const response = assertionFor(options.challenge);

    await expect(finishLogin(response, at(CHALLENGE_TTL_MS))).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("is still accepted one second before the five-minute mark", async () => {
    const userId = await createUser("just-in-time@example.test");
    await insertPasskey(userId, { credentialId: "cred-a" });
    const options = await beginLogin(at(0));
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(verifiedAssertion(1));

    await expect(finishLogin(assertionFor(options.challenge), at(CHALLENGE_TTL_MS - 1000))).resolves.toEqual(expect.any(String));
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it("a challenge issued for registration cannot be used to sign in", async () => {
    const userId = await createUser("cross-register@example.test");
    await insertPasskey(userId, { credentialId: "cred-a" });
    const options = await beginRegistration(userId, at(0));

    await expect(finishLogin(assertionFor(options.challenge), at(1000))).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("a challenge from an unknown source is refused generically and creates no session", async () => {
    await createUser("unknown-challenge@example.test");
    const response = assertionFor("never-issued-challenge");

    await expect(finishLogin(response, at(0))).rejects.toBeInstanceOf(PasskeyLoginError);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("a response with malformed clientDataJSON is refused generically", async () => {
    const response = assertionFor("x");
    response.response.clientDataJSON = "not base64url json!!";
    await expect(finishLogin(response, at(0))).rejects.toBeInstanceOf(PasskeyLoginError);
  });
});

describe("registration challenges", () => {
  it("is single use: a second registration with the same challenge is refused", async () => {
    const userId = await createUser("reg-single@example.test");
    const options = await beginRegistration(userId, at(0));
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-new", new Uint8Array([1, 2, 3])));
    const response = attestationFor(options.challenge);

    await expect(finishRegistration(userId, response, "Laptop", at(1000))).resolves.toMatchObject({ label: "Laptop" });
    await expect(finishRegistration(userId, response, "Laptop", at(2000))).rejects.toBeInstanceOf(PasskeyRegistrationError);
    expect(verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  it("expires five minutes after it was issued", async () => {
    const userId = await createUser("reg-expiry@example.test");
    const options = await beginRegistration(userId, at(0));

    await expect(finishRegistration(userId, attestationFor(options.challenge), "Phone", at(CHALLENGE_TTL_MS))).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("a login challenge cannot register a passkey", async () => {
    const userId = await createUser("login-register@example.test");
    const options = await beginLogin(at(0));

    await expect(finishRegistration(userId, attestationFor(options.challenge), "Phone", at(1000))).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("a challenge bound to one user cannot register a passkey for another, and the owner can still use it", async () => {
    const owner = await createUser("owner@example.test");
    const other = await createUser("other@example.test");
    const options = await beginRegistration(owner, at(0));
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-new", new Uint8Array([9])));

    await expect(finishRegistration(other, attestationFor(options.challenge), "Stolen", at(1000))).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();

    // The refused attempt did not spend the challenge, so the owner can still finish.
    await expect(finishRegistration(owner, attestationFor(options.challenge), "Mine", at(2000))).resolves.toMatchObject({ label: "Mine" });
  });

  it("a registration response for a credential that is already stored is refused without saying why", async () => {
    const owner = await createUser("dup-owner@example.test");
    const other = await createUser("dup-other@example.test");
    await insertPasskey(owner, { credentialId: "cred-taken" });
    const options = await beginRegistration(other, at(0));
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-taken", new Uint8Array([7])));

    await expect(finishRegistration(other, attestationFor(options.challenge, "cred-taken"), "Dup", at(1000))).rejects.toThrow(
      "We could not save that passkey. Try again.",
    );
  });

  it("after a day, a challenge that was never used is no longer in the table", async () => {
    const userId = await createUser("cleanup@example.test");
    const options = await beginRegistration(userId, at(0));
    await beginRegistration(userId, at(DAY + 2 * MINUTE));
    const { rows } = await adminQuery("select 1 from webauthn_challenges where challenge = $1", [options.challenge]);
    expect(rows).toHaveLength(0);
  });
});
