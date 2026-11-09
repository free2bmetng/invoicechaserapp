// Passkey (WebAuthn) sign-in and registration. @simplewebauthn does the cryptography. This module
// does the parts that belong to this app: challenges, the account lookup, the counter and storage.
//
// Passkeys are discoverable (resident) credentials, so sign-in needs no username, and user
// verification is required. The relying-party ID is the hostname of APP_URL, and the expected
// origin is the origin of APP_URL.
//
// Failures reach callers as one of the Passkey*Error classes. Their messages are generic on purpose,
// so a response never reveals whether a credential exists or which check failed.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import { startSession } from "@/lib/auth";
import type { Clock } from "@/lib/clock";
import { withService, withUser } from "@/lib/db";
import { provisionUser } from "@/lib/engine";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_LABEL_MAX_LENGTH = 40;
export const DEFAULT_PASSKEY_LABEL = "This device";

// Challenge creation (login and registration options) is limited to 20 per client address in 10 minutes.
// The window lives in this process. See takeChallengeSlot for what that does and does not guarantee.
export const CHALLENGE_RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 } as const;

export const PASSKEY_LOGIN_FAILED = "We could not sign you in with that passkey. Use the email link instead.";
export const PASSKEY_SAVE_FAILED = "We could not save that passkey. Try again.";
export const PASSKEY_RATE_LIMITED = "Too many attempts. Wait a few minutes and try again.";
export const PASSKEY_UNAVAILABLE = "Passkeys are not available right now. Use the email link instead.";

const RELYING_PARTY_NAME = "Invoice Chaser";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNUSED_CHALLENGE_RETENTION_MS = 60 * 60 * 1000;

export class PasskeyLoginError extends Error {
  constructor() {
    super(PASSKEY_LOGIN_FAILED);
    this.name = "PasskeyLoginError";
  }
}

export class PasskeyRegistrationError extends Error {
  constructor() {
    super(PASSKEY_SAVE_FAILED);
    this.name = "PasskeyRegistrationError";
  }
}

export class PasskeyNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyNotConfiguredError";
  }
}

export type PasskeySummary = {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

type Purpose = "login" | "register";

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: string;
  transports: string[];
};

// The relying party is derived from APP_URL, so the origin and RP ID always match the site
// the browser is on. A mismatch fails the WebAuthn checks rather than silently allowing a different site.
export function relyingParty(): { rpID: string; origin: string } {
  const raw = process.env.APP_URL;
  if (!raw) throw new PasskeyNotConfiguredError("APP_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PasskeyNotConfiguredError("APP_URL is not a valid URL");
  }
  return { rpID: url.hostname, origin: url.origin };
}

// Replay guard. An authenticator that does not count reports 0 every time, which is allowed.
// Any other value must go up. The library enforces the same rule; this check also covers results we did not verify ourselves.
export function counterAdvanced(stored: number, next: number): boolean {
  if (next === 0 && stored === 0) return true;
  return next > stored;
}

// Keeps the first 40 characters, with control and bidi-override characters replaced. Blank becomes the default.
const UNSAFE_LABEL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export function sanitizePasskeyLabel(input: unknown): string {
  const text = typeof input === "string" ? input : "";
  const cleaned = text.replace(UNSAFE_LABEL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  const clipped = Array.from(cleaned).slice(0, PASSKEY_LABEL_MAX_LENGTH).join("").trim();
  return clipped || DEFAULT_PASSKEY_LABEL;
}

async function issueChallenge(challenge: string, purpose: Purpose, userId: string | null, clock: Clock): Promise<void> {
  const now = clock.now();
  await withService(async (c) => {
    // Rows that expired an hour ago can never be claimed again, so they are dropped here.
    await c.query("delete from webauthn_challenges where expires_at < $1", [
      new Date(now.getTime() - UNUSED_CHALLENGE_RETENTION_MS),
    ]);
    await c.query(
      "insert into webauthn_challenges (challenge, purpose, user_id, expires_at, created_at) values ($1, $2, $3, $4, $5)",
      [challenge, purpose, userId, new Date(now.getTime() + CHALLENGE_TTL_MS), now],
    );
  });
}

function readChallenge(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string") return null;
  try {
    const { challenge } = decodeClientDataJSON(clientDataJSON);
    return typeof challenge === "string" && challenge.length > 0 ? challenge : null;
  } catch {
    return null;
  }
}

// Claims the challenge the authenticator signed, in one statement. The claim succeeds only for a
// challenge that has the same purpose and user, has not been used, and has not expired. Once claimed,
// the challenge is spent, whatever the rest of the check decides.
async function claimChallenge(
  clientDataJSON: unknown,
  purpose: Purpose,
  userId: string | null,
  clock: Clock,
): Promise<string | null> {
  const challenge = readChallenge(clientDataJSON);
  if (!challenge) return null;
  const now = clock.now();
  return withService(async (c) => {
    const { rows } = await c.query<{ challenge: string }>(
      `update webauthn_challenges set used_at = $1
        where challenge = $2 and purpose = $3 and user_id is not distinct from $4
          and used_at is null and expires_at > $1
        returning challenge`,
      [now, challenge, purpose, userId],
    );
    return rows[0]?.challenge ?? null;
  });
}

// Options for navigator.credentials.get(). No allowCredentials: the passkey identifies the account.
export async function beginLogin(clock: Clock): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  await issueChallenge(options.challenge, "login", null, clock);
  return options;
}

// Verifies a sign-in and returns the raw session token for the caller to store in a cookie.
export async function finishLogin(response: AuthenticationResponseJSON, clock: Clock): Promise<string> {
  const { rpID, origin } = relyingParty();
  const challenge = await claimChallenge(response?.response?.clientDataJSON, "login", null, clock);
  if (!challenge || typeof response?.id !== "string") throw new PasskeyLoginError();

  const passkey = await withService(async (c) => {
    const { rows } = await c.query<PasskeyRow>(
      "select id, user_id, credential_id, public_key, counter::text as counter, transports from passkeys where credential_id = $1",
      [response.id],
    );
    return rows[0] ?? null;
  });
  if (!passkey) throw new PasskeyLoginError();

  const stored = Number(passkey.counter);
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: passkey.credential_id,
      publicKey: isoBase64URL.toBuffer(passkey.public_key),
      counter: stored,
      transports: passkey.transports,
    },
    requireUserVerification: true,
  }).catch(() => null);
  if (!verified?.verified) throw new PasskeyLoginError();

  const next = verified.authenticationInfo.newCounter;
  if (!counterAdvanced(stored, next)) throw new PasskeyLoginError();

  // Compare-and-swap on the old counter. Two sign-ins racing on one passkey cannot both succeed.
  const now = clock.now();
  const moved = await withService(async (c) => {
    const { rowCount } = await c.query(
      "update passkeys set counter = $1, last_used_at = $2 where id = $3 and user_id = $4 and counter = $5",
      [next, now, passkey.id, passkey.user_id, stored],
    );
    return rowCount === 1;
  });
  if (!moved) throw new PasskeyLoginError();

  // Passkey sign-in is a sign-in, so it runs the same idempotent provisioning as the magic link.
  await provisionUser(passkey.user_id, clock);
  return startSession(passkey.user_id, clock);
}

// Options for navigator.credentials.create(). The caller must already have authenticated the user.
// Existing passkeys are excluded so the same authenticator cannot register twice.
export async function beginRegistration(userId: string, clock: Clock): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty();
  const { email, credentials } = await withUser(userId, async (c) => {
    const user = await c.query<{ email: string }>("select email from users where id = $1", [userId]);
    const existing = await c.query<{ credential_id: string; transports: string[] }>(
      "select credential_id, transports from passkeys where user_id = $1 order by created_at",
      [userId],
    );
    return { email: user.rows[0]?.email ?? null, credentials: existing.rows };
  });
  if (!email) throw new PasskeyRegistrationError();

  const options = await generateRegistrationOptions({
    rpName: RELYING_PARTY_NAME,
    rpID,
    userName: email,
    userDisplayName: email,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: credentials.map((row) => ({ id: row.credential_id, transports: row.transports })),
    // Discoverable credential, with user verification. requireResidentKey is kept for older clients.
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  });
  await issueChallenge(options.challenge, "register", userId, clock);
  return options;
}

// Verifies a registration for one user and stores the passkey. A challenge issued to another user
// is not found, so a passkey can never be stored under an account that did not start the ceremony.
export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  label: unknown,
  clock: Clock,
): Promise<{ id: string; label: string }> {
  const { rpID, origin } = relyingParty();
  const challenge = await claimChallenge(response?.response?.clientDataJSON, "register", userId, clock);
  if (!challenge) throw new PasskeyRegistrationError();

  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  }).catch(() => null);
  const info = verified?.verified ? verified.registrationInfo : undefined;
  if (!info) throw new PasskeyRegistrationError();

  const passkeyLabel = sanitizePasskeyLabel(label);
  const transports = Array.isArray(response.response.transports) ? response.response.transports : [];
  const now = clock.now();
  try {
    const row = await withUser(userId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into passkeys (user_id, credential_id, public_key, counter, transports, label, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          userId,
          info.credential.id,
          isoBase64URL.fromBuffer(info.credential.publicKey),
          info.credential.counter,
          transports,
          passkeyLabel,
          now,
        ],
      );
      return rows[0];
    });
    return { id: row.id, label: passkeyLabel };
  } catch (err) {
    // The credential id is unique. A repeat, for this user or another, fails here without saying which.
    if (isUniqueViolation(err)) throw new PasskeyRegistrationError();
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

// The account's passkeys, read under row-level security. Public keys and counters are not returned.
export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ id: string; label: string; created_at: Date; last_used_at: Date | null }>(
      "select id, label, created_at, last_used_at from passkeys where user_id = $1 order by created_at",
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  });
}

// Removes one of the user's own passkeys. Removing the last one is allowed, because the email link still signs the user in.
export async function removePasskey(userId: string, id: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  return withUser(userId, async (c) => {
    const { rowCount } = await c.query("delete from passkeys where id = $1 and user_id = $2", [id, userId]);
    return rowCount === 1;
  });
}

// Challenge-creation rate limit. Each address gets 20 challenges per 10 minutes, across login and registration.
// The windows are kept in memory for this process. A single instance cannot be flooded past the limit,
// but each instance keeps its own count. A shared count needs a table, and this change does not add one.
const challengeHits = new Map<string, number[]>();
const MAX_TRACKED_ADDRESSES = 10_000;

export function takeChallengeSlot(address: string, clock: Clock): boolean {
  const now = clock.now().getTime();
  const windowStart = now - CHALLENGE_RATE_LIMIT.windowMs;
  const recent = (challengeHits.get(address) ?? []).filter((at) => at > windowStart);
  if (recent.length >= CHALLENGE_RATE_LIMIT.max) {
    challengeHits.set(address, recent);
    return false;
  }
  recent.push(now);
  challengeHits.set(address, recent);
  if (challengeHits.size > MAX_TRACKED_ADDRESSES) pruneChallengeHits(windowStart);
  return true;
}

function pruneChallengeHits(windowStart: number): void {
  for (const [address, hits] of challengeHits) {
    if (hits.every((at) => at <= windowStart)) challengeHits.delete(address);
  }
}
