// Starts a passkey sign-in. No session is needed: the passkey itself identifies the account.
// Creating a challenge is rate limited per client address (see takeChallengeSlot).
import { systemClock } from "@/lib/clock";
import { errorResponse, clientAddress, jsonResponse, logPasskeyFailure } from "@/lib/passkey-http";
import { beginLogin, PASSKEY_RATE_LIMITED, PASSKEY_UNAVAILABLE, takeChallengeSlot } from "@/lib/passkeys";

export async function POST(request: Request) {
  if (!takeChallengeSlot(clientAddress(request), systemClock)) {
    return errorResponse(PASSKEY_RATE_LIMITED, 429);
  }
  try {
    return jsonResponse(await beginLogin(systemClock));
  } catch (err) {
    logPasskeyFailure("sign-in options", err);
    return errorResponse(PASSKEY_UNAVAILABLE, 503);
  }
}
