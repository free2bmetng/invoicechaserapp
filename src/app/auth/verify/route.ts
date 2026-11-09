// Consumes a magic-link token and starts a session. Every outcome redirects to a fixed
// path on this app, so the link cannot be used to send the browser elsewhere.
import { NextResponse } from "next/server";
import { consumeMagicLink, LoginLinkInvalidError } from "@/lib/auth";
import { systemClock } from "@/lib/clock";
import { PASSKEY_OFFER_COOKIE, PASSKEY_OFFER_COOKIE_OPTIONS } from "@/lib/passkey-offer";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const { sessionToken } = await consumeMagicLink(token, systemClock);
    const response = NextResponse.redirect(new URL("/", request.url), 303);
    response.cookies.set(SESSION_COOKIE, sessionToken, SESSION_COOKIE_OPTIONS);
    // A magic-link sign-in is the moment to offer a passkey for this device. The shell shows the offer once.
    response.cookies.set(PASSKEY_OFFER_COOKIE, "1", PASSKEY_OFFER_COOKIE_OPTIONS);
    return response;
  } catch (err) {
    // Unknown, expired and already-used links look the same on purpose.
    const code = err instanceof LoginLinkInvalidError ? "expired" : "unavailable";
    return NextResponse.redirect(new URL(`/login?error=${code}`, request.url), 303);
  }
}
