// Verifies a passkey sign-in and sets the session cookie. Every failure returns the same message.
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { systemClock } from "@/lib/clock";
import { errorResponse, jsonResponse, logPasskeyFailure, readJsonBody } from "@/lib/passkey-http";
import { PASSKEY_LOGIN_FAILED, PASSKEY_UNAVAILABLE, PasskeyLoginError, finishLogin } from "@/lib/passkeys";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body || typeof body.response !== "object" || body.response === null) {
    return errorResponse(PASSKEY_LOGIN_FAILED, 400);
  }
  try {
    const sessionToken = await finishLogin(body.response as AuthenticationResponseJSON, systemClock);
    const response = jsonResponse({ ok: true });
    response.cookies.set(SESSION_COOKIE, sessionToken, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (err) {
    if (err instanceof PasskeyLoginError) return errorResponse(PASSKEY_LOGIN_FAILED, 401);
    logPasskeyFailure("sign-in", err);
    return errorResponse(PASSKEY_UNAVAILABLE, 503);
  }
}
