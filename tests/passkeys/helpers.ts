// Shared fixtures for the passkey tests. No authenticator is simulated. The WebAuthn responses built
// here are structurally valid JSON with empty signatures. They exercise the server's checks that run
// before the cryptographic step. Tests that need that step to succeed mock the library's verify call.
import type { AuthenticationResponseJSON, RegistrationResponseJSON, VerifiedAuthenticationResponse, VerifiedRegistrationResponse } from "@simplewebauthn/server";
import { adminQuery } from "../helpers/db";

export const ORIGIN = "http://localhost:3000";
export const T0 = "2026-11-09T09:00:00.000Z";
export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

export async function resetPasskeyDb(): Promise<void> {
  await adminQuery(
    "truncate table users, login_tokens, sessions, passkeys, webauthn_challenges, events restart identity cascade",
  );
}

export async function insertPasskey(
  userId: string,
  opts: { credentialId: string; counter?: number; label?: string },
): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    `insert into passkeys (user_id, credential_id, public_key, counter, transports, label)
     values ($1, $2, 'cHVibGljLWtleQ', $3, '{internal}', $4) returning id`,
    [userId, opts.credentialId, opts.counter ?? 0, opts.label ?? "This device"],
  );
  return rows[0].id;
}

export async function challengeRows(challenge: string) {
  const { rows } = await adminQuery<{ purpose: string; user_id: string | null; used_at: Date | null; expires_at: Date }>(
    "select purpose, user_id, used_at, expires_at from webauthn_challenges where challenge = $1",
    [challenge],
  );
  return rows;
}

// clientDataJSON as the browser encodes it. The challenge is what the server looks up.
function clientData(type: string, challenge: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false })).toString("base64url");
}

export function assertionFor(challenge: string, id = "cred-a"): AuthenticationResponseJSON {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: clientData("webauthn.get", challenge), authenticatorData: "", signature: "" },
  };
}

export function attestationFor(challenge: string, id = "cred-new", transports?: string[]): RegistrationResponseJSON {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData("webauthn.create", challenge),
      attestationObject: "",
      ...(transports ? { transports: transports as never } : {}),
    },
  };
}

// The result the library returns for a verified assertion. Only the counter matters to our code.
export function verifiedAssertion(newCounter: number, credentialID = "cred-a"): VerifiedAuthenticationResponse {
  return {
    verified: true,
    authenticationInfo: {
      credentialID,
      newCounter,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  };
}

export function verifiedAttestation(id: string, publicKey: Uint8Array<ArrayBuffer>, counter = 0): VerifiedRegistrationResponse {
  return {
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id, publicKey, counter },
      credentialType: "public-key",
      attestationObject: new Uint8Array(new ArrayBuffer(0)),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  };
}
