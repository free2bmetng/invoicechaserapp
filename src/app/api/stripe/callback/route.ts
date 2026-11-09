// Stripe Connect return. Checks the session and the state cookie, exchanges the code for the
// connected account, and stores it. Then redirects to /settings with a short status. The state
// cookie is cleared on every response.
import { currentUserId } from "@/lib/auth";
import { systemClock } from "@/lib/clock";
import { connectStripeOAuth } from "@/lib/providers/stripe-connection";
import {
  clearStateCookieHeader,
  OAUTH_STATE_COOKIE,
  readCookie,
  StripeOAuthError,
  stateMatches,
} from "@/lib/providers/stripe-oauth";
import { SESSION_COOKIE } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return new Response("Stripe Connect is not configured.", { status: 500 });
  const secure = process.env.NODE_ENV === "production";

  const back = (status: "connected" | "error", reason?: string): Response => {
    const location = new URL("/settings", appUrl);
    location.searchParams.set("stripe", status);
    if (reason) location.searchParams.set("reason", reason);
    const headers = new Headers({ location: location.toString(), "cache-control": "no-store" });
    headers.append("set-cookie", clearStateCookieHeader(secure));
    return new Response(null, { status: 303, headers });
  };

  const userId = await currentUserId(readCookie(request, SESSION_COOKIE), systemClock);
  if (!userId) return back("error", "signin");

  const params = new URL(request.url).searchParams;
  if (!stateMatches(readCookie(request, OAUTH_STATE_COOKIE), params.get("state"))) {
    return back("error", "state");
  }
  if (params.get("error")) return back("error", "denied");
  const code = params.get("code");
  if (!code) return back("error", "missing_code");

  try {
    await connectStripeOAuth(userId, code);
    return back("connected");
  } catch (err) {
    if (err instanceof StripeOAuthError) return back("error", err.reason);
    throw err;
  }
}
