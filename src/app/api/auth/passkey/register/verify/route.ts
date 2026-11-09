// Stores a passkey for the signed-in user after the browser has created it. Without a session the answer is 401.
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { systemClock } from "@/lib/clock";
import { errorResponse, jsonResponse, logPasskeyFailure, readJsonBody } from "@/lib/passkey-http";
import {
  finishRegistration,
  PASSKEY_SAVE_FAILED,
  PASSKEY_UNAVAILABLE,
  PasskeyRegistrationError,
} from "@/lib/passkeys";
import { getUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return errorResponse("Sign in before you add a passkey.", 401);

  const body = await readJsonBody(request);
  if (!body || typeof body.response !== "object" || body.response === null) {
    return errorResponse(PASSKEY_SAVE_FAILED, 400);
  }
  try {
    const passkey = await finishRegistration(userId, body.response as RegistrationResponseJSON, body.label, systemClock);
    return jsonResponse({ ok: true, passkey });
  } catch (err) {
    if (err instanceof PasskeyRegistrationError) return errorResponse(PASSKEY_SAVE_FAILED, 400);
    logPasskeyFailure("registration", err);
    return errorResponse(PASSKEY_UNAVAILABLE, 503);
  }
}
