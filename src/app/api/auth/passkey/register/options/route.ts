// Starts adding a passkey for the signed-in user. Without a session the answer is 401.
import { systemClock } from "@/lib/clock";
import { errorResponse, clientAddress, jsonResponse, logPasskeyFailure } from "@/lib/passkey-http";
import {
  beginRegistration,
  PASSKEY_RATE_LIMITED,
  PASSKEY_UNAVAILABLE,
  takeChallengeSlot,
} from "@/lib/passkeys";
import { getUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return errorResponse("Sign in before you add a passkey.", 401);
  if (!takeChallengeSlot(clientAddress(request), systemClock)) {
    return errorResponse(PASSKEY_RATE_LIMITED, 429);
  }
  try {
    return jsonResponse(await beginRegistration(userId, systemClock));
  } catch (err) {
    logPasskeyFailure("registration options", err);
    return errorResponse(PASSKEY_UNAVAILABLE, 503);
  }
}
