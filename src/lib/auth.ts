// Sign-in: a single-use magic link, or a passkey (see passkeys.ts), becomes a sliding 90-day
// session token. This replaces Supabase Auth (a documented deviation, see PROGRESS.md). Raw tokens
// are never stored and never logged; only their SHA-256 hashes reach the database.
import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "@/lib/clock";
import { withService } from "@/lib/db";
import { provisionUser } from "@/lib/engine";
import { authEmailProvider } from "@/lib/providers/factory";
import type { OutgoingEmail } from "@/lib/providers/types";

export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;
// Sessions slide. A use that finds the expiry set more than SESSION_REFRESH_AFTER_MS ago pushes it
// out by the full TTL. Other uses do not write, so an active user costs one write a day, not one per request.
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const LOGIN_RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 } as const;

const MAX_TOKEN_LENGTH = 256;

export class InvalidEmailError extends Error {
  constructor() {
    super("Enter a valid email address.");
    this.name = "InvalidEmailError";
  }
}

export class LoginRateLimitedError extends Error {
  constructor() {
    super("Too many sign-in links were requested. Wait a few minutes and try again.");
    this.name = "LoginRateLimitedError";
  }
}

// Unknown, expired and already-used links all raise this, so the caller cannot tell them apart.
export class LoginLinkInvalidError extends Error {
  constructor() {
    super("This sign-in link is invalid or has expired. Request a new one.");
    this.name = "LoginLinkInvalidError";
  }
}

export class AuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthNotConfiguredError";
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function isPlausibleEmail(address: string): boolean {
  return address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function sendingEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new AuthNotConfiguredError(`${name} is not set`);
  return value;
}

function verifyLink(appUrl: string, token: string): string {
  const link = new URL("/auth/verify", appUrl);
  link.searchParams.set("token", token);
  return link.toString();
}

function loginEmail(to: string, token: string, appUrl: string, from: string): OutgoingEmail {
  const link = verifyLink(appUrl, token);
  return {
    from: { name: "Invoice Chaser", address: from },
    replyTo: from,
    to,
    cc: [],
    subject: "Your Invoice Chaser sign-in link",
    text: [
      "Sign in to Invoice Chaser with this link:",
      "",
      link,
      "",
      "The link works once and expires in 15 minutes. If you did not ask for it, ignore this email.",
    ].join("\n"),
    idempotencyKey: `login:${hashToken(token)}`,
  };
}

// Issues a login token. Returns devLink only when sending is off outside production,
// so local development works. In production with sending off, nothing is issued,
// because a returned link would let anyone sign in as any address.
export async function requestMagicLink(email: string, clock: Clock): Promise<{ devLink?: string }> {
  const address = normalizeEmail(email);
  if (!isPlausibleEmail(address)) throw new InvalidEmailError();

  const sending = sendingEnabled();
  if (!sending && process.env.NODE_ENV === "production") {
    throw new AuthNotConfiguredError("Sign-in email is not configured (SEND_ENABLED is not true).");
  }
  const appUrl = requireEnv("APP_URL");
  // Validated before a token is stored, so a misconfiguration never burns a rate-limit slot.
  const sender = sending ? requireEnv("AUTH_EMAIL_FROM") : undefined;

  const token = newToken();
  const now = clock.now();
  await withService(async (c) => {
    // Serialise requests for one address so concurrent calls cannot both pass the limit.
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`login:${address}`]);
    const { rows } = await c.query<{ n: string }>(
      "select count(*)::text as n from login_tokens where email = $1 and created_at > $2",
      [address, new Date(now.getTime() - LOGIN_RATE_LIMIT.windowMs)],
    );
    if (Number(rows[0].n) >= LOGIN_RATE_LIMIT.max) throw new LoginRateLimitedError();
    await c.query(
      "insert into login_tokens (email, token_hash, expires_at, created_at) values ($1, $2, $3, $4)",
      [address, hashToken(token), new Date(now.getTime() + LOGIN_LINK_TTL_MS), now],
    );
  });

  if (sender !== undefined) {
    await authEmailProvider().send(loginEmail(address, token, appUrl, sender));
    return {};
  }
  return { devLink: verifyLink(appUrl, token) };
}

// Claims a login token exactly once and signs the user in. Returns the raw session token,
// which the caller stores in a cookie.
export async function consumeMagicLink(
  token: string,
  clock: Clock,
): Promise<{ sessionToken: string; userId: string }> {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new LoginLinkInvalidError();
  const now = clock.now();

  // One statement claims the token. Two requests racing on the same link cannot both win.
  const email = await withService(async (c) => {
    const { rows } = await c.query<{ email: string }>(
      `update login_tokens set used_at = $2
        where token_hash = $1 and used_at is null and expires_at > $2
        returning email`,
      [hashToken(token), now],
    );
    return rows[0]?.email ?? null;
  });
  if (!email) throw new LoginLinkInvalidError();

  const userId = await withService(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into users (email) values ($1)
        on conflict (email) do update set email = excluded.email
        returning id`,
      [email],
    );
    return rows[0].id;
  });

  // Runs on every sign-in, so it must be idempotent. Running it after the user row
  // commits means a failure here is retried on the next sign-in.
  await provisionUser(userId, clock);

  const sessionToken = await startSession(userId, clock);
  return { sessionToken, userId };
}

// Stores a new session and returns its raw token. Magic-link and passkey sign-in both use it.
export async function startSession(userId: string, clock: Clock): Promise<string> {
  const sessionToken = newToken();
  const now = clock.now();
  await withService((c) =>
    c.query(
      "insert into sessions (id_hash, user_id, expires_at, created_at) values ($1, $2, $3, $4)",
      [hashToken(sessionToken), userId, new Date(now.getTime() + SESSION_TTL_MS), now],
    ),
  );
  return sessionToken;
}

// Returns the signed-in user's id, or null when there is no live session. A live session slides:
// when its expiry was last set more than SESSION_REFRESH_AFTER_MS ago, this use extends it.
export async function currentUserId(sessionToken: string | undefined, clock: Clock): Promise<string | null> {
  if (!sessionToken || sessionToken.length > MAX_TOKEN_LENGTH) return null;
  const now = clock.now();
  const idHash = hashToken(sessionToken);
  return withService(async (c) => {
    const { rows } = await c.query<{ user_id: string; expires_at: Date }>(
      "select user_id, expires_at from sessions where id_hash = $1 and expires_at > $2",
      [idHash, now],
    );
    const session = rows[0];
    if (!session) return null;
    // Equivalent to: the expiry was last set (expires_at - TTL) more than the refresh interval ago.
    const refreshBefore = new Date(now.getTime() + SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS);
    if (session.expires_at < refreshBefore) {
      await c.query("update sessions set expires_at = $2 where id_hash = $1", [idHash, new Date(now.getTime() + SESSION_TTL_MS)]);
    }
    return session.user_id;
  });
}

export async function endSession(sessionToken: string): Promise<void> {
  if (!sessionToken || sessionToken.length > MAX_TOKEN_LENGTH) return;
  await withService((c) => c.query("delete from sessions where id_hash = $1", [hashToken(sessionToken)]));
}
