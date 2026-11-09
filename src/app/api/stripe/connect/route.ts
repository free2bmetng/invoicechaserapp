// Starts Stripe Connect (OAuth, Standard). The visitor must have a session. A random state goes
// into a short-lived httpOnly cookie, and the browser is sent to Stripe's authorize page. The
// callback compares that cookie with the state Stripe returns.
import { currentUserId } from "@/lib/auth";
import { systemClock } from "@/lib/clock";
import { SESSION_COOKIE } from "@/lib/session";
import {
  newOAuthState,
  oauthAuthorizeUrl,
  oauthRedirectUri,
  readCookie,
  stateCookieHeader,
} from "@/lib/providers/stripe-oauth";

export async function GET(request: Request): Promise<Response> {
  const userId = await currentUserId(readCookie(request, SESSION_COOKIE), systemClock);
  if (!userId) return new Response("Sign in before connecting Stripe.", { status: 401 });

  const appUrl = process.env.APP_URL;
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!appUrl || !clientId) return new Response("Stripe Connect is not configured.", { status: 500 });

  const state = newOAuthState();
  const headers = new Headers({
    location: oauthAuthorizeUrl({ clientId, redirectUri: oauthRedirectUri(appUrl), state }),
    "cache-control": "no-store",
  });
  headers.append("set-cookie", stateCookieHeader(state, process.env.NODE_ENV === "production"));
  return new Response(null, { status: 302, headers });
}
