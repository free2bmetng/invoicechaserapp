// Browser side of adding a passkey: fetch options, ask the device to create the credential, then send it back.
// Used by the sign-in offer card and by the settings page.
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useSyncExternalStore } from "react";

export type AddPasskeyResult = { ok: true; label: string } | { ok: false; message: string };

const SAVE_FAILED = "We could not save that passkey. Try again.";
const DEVICE_LABEL = "This device";

// True when this browser exposes the WebAuthn API.
export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

// Reads browser support without an effect. The server snapshot is false, so the server render and the
// first client render agree, and the value updates on the client once hydration is done.
const noSubscribe = () => () => {};
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(noSubscribe, browserSupportsPasskeys, () => false);
}

export async function addPasskeyOnThisDevice(): Promise<AddPasskeyResult> {
  try {
    const optionsResponse = await fetch("/api/auth/passkey/register/options", {
      method: "POST",
      cache: "no-store",
    });
    if (optionsResponse.status === 401) return { ok: false, message: "Sign in again, then add a passkey." };
    if (optionsResponse.status === 429) return { ok: false, message: "Too many attempts. Wait a few minutes and try again." };
    if (!optionsResponse.ok) return { ok: false, message: SAVE_FAILED };

    const optionsJSON = (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
    const response = await startRegistration({ optionsJSON });

    const verifyResponse = await fetch("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, label: DEVICE_LABEL }),
      cache: "no-store",
    });
    if (!verifyResponse.ok) return { ok: false, message: SAVE_FAILED };
    return { ok: true, label: DEVICE_LABEL };
  } catch (err) {
    if (isCancelled(err)) return { ok: false, message: "Passkey setup was cancelled. Nothing was changed." };
    if (isAlreadyRegistered(err)) return { ok: false, message: "This device already has a passkey for your account." };
    return { ok: false, message: SAVE_FAILED };
  }
}

// The browser reports a dismissed prompt or a timeout as NotAllowedError.
export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "NotAllowedError";
}

// The browser reports an authenticator that is already in excludeCredentials as InvalidStateError.
function isAlreadyRegistered(err: unknown): boolean {
  return err instanceof Error && err.name === "InvalidStateError";
}
