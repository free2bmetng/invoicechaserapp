// Stripe Connect OAuth (Standard accounts). These are pure helpers: the authorize URL, the state
// cookie that guards the callback, the token exchange, and the deauthorize call. Storage lives in
// stripe-connection.ts. Payments for a connected account pass stripeAccount (see stripe.ts).
//
// A connected account id is stored in connected_accounts.account_label, so no schema change is
// needed. isStripeAccountId is how a row is recognised as an OAuth connection.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { StripeOAuthClient } from "./stripe-platform";

export const OAUTH_STATE_COOKIE = "stripe_oauth_state";
export const OAUTH_CALLBACK_PATH = "/api/stripe/callback";
const OAUTH_STATE_MAX_AGE_S = 600;
const AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

export type StripeOAuthFailure =
  | "config"
  | "denied"
  | "state"
  | "missing_code"
  | "exchange"
  | "already_connected";

export class StripeOAuthError extends Error {
  readonly reason: StripeOAuthFailure;

  constructor(reason: StripeOAuthFailure, message: string) {
    super(message);
    this.name = "StripeOAuthError";
    this.reason = reason;
  }
}

export function isStripeAccountId(label: string): boolean {
  return STRIPE_ACCOUNT_ID.test(label);
}

export function oauthRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

// Constant-time comparison. A missing cookie or missing query value never matches.
export function stateMatches(cookieValue: string | undefined, queryState: string | null): boolean {
  if (!cookieValue || !queryState) return false;
  const a = Buffer.from(cookieValue, "utf8");
  const b = Buffer.from(queryState, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieFlags(secure: boolean): string {
  return `Path=/api/stripe; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function stateCookieHeader(value: string, secure: boolean): string {
  return `${OAUTH_STATE_COOKIE}=${value}; Max-Age=${OAUTH_STATE_MAX_AGE_S}; ${cookieFlags(secure)}`;
}

export function clearStateCookieHeader(secure: boolean): string {
  return `${OAUTH_STATE_COOKIE}=; Max-Age=0; ${cookieFlags(secure)}`;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Only the account id is kept. Payments and deauthorize use the platform key with that id, so
// the access token Stripe returns is never read, stored or logged.
export interface ExchangedAccount {
  stripeAccountId: string;
  livemode: boolean;
}

export async function exchangeOAuthCode(client: StripeOAuthClient, code: string): Promise<ExchangedAccount> {
  let token: Awaited<ReturnType<StripeOAuthClient["oauth"]["token"]>>;
  try {
    token = await client.oauth.token({ grant_type: "authorization_code", code });
  } catch {
    throw new StripeOAuthError("exchange", "Stripe did not accept the authorization code. Try connecting again.");
  }
  const accountId = token.stripe_user_id;
  if (!accountId || !STRIPE_ACCOUNT_ID.test(accountId)) {
    throw new StripeOAuthError("exchange", "Stripe did not return a connected account.");
  }
  return { stripeAccountId: accountId, livemode: token.livemode === true };
}

// Returns false when Stripe refuses. The caller still removes the stored token.
export async function deauthorizeAccount(
  client: StripeOAuthClient,
  clientId: string,
  stripeAccountId: string,
): Promise<boolean> {
  try {
    await client.oauth.deauthorize({ client_id: clientId, stripe_user_id: stripeAccountId });
    return true;
  } catch {
    return false;
  }
}
