"use client";

// Passkey sign-in on the login screen: the primary way in. The login form renders it only where the
// browser supports WebAuthn, and keeps it on screen through email errors, so the user always has both
// ways in. While the device prompt is open the button is aria-disabled rather than disabled, so focus
// stays on it, and an error is announced next to it.
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useState } from "react";
import { isCancelled } from "@/components/passkey/add-passkey";
import { Button } from "@/components/ui";

const FAILED = "We couldn't sign you in with that passkey. Try again, or use the email link below.";
const CANCELLED = "Passkey sign-in was cancelled. Try again, or use the email link below.";
const RATE_LIMITED = "Too many attempts. Wait a few minutes, or use the email link below.";

function PasskeyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5 1.2 0 2.3.3 3.2 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="17" cy="14" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M17 16.2V21m0-2h1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PasskeySignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/login/options", { method: "POST", cache: "no-store" });
      if (!optionsResponse.ok) {
        setError(optionsResponse.status === 429 ? RATE_LIMITED : FAILED);
        setBusy(false);
        return;
      }
      const optionsJSON = (await optionsResponse.json()) as PublicKeyCredentialRequestOptionsJSON;
      const response = await startAuthentication({ optionsJSON });

      const verifyResponse = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
        cache: "no-store",
      });
      if (!verifyResponse.ok) {
        setError(FAILED);
        setBusy(false);
        return;
      }
      // A full load, so the signed-in shell renders with the new session cookie. A client-side
      // navigation would reuse the signed-out route cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/");
    } catch (err) {
      setError(isCancelled(err) ? CANCELLED : FAILED);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="primary"
        className={busy ? "w-full cursor-progress opacity-80" : "w-full"}
        onClick={signIn}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby={error ? "passkey-error" : "passkey-hint"}
      >
        <PasskeyIcon />
        {busy ? "Waiting for your device…" : "Sign in with a passkey"}
      </Button>
      {error ? (
        <p id="passkey-error" role="alert" className="text-small font-medium text-danger">
          {error}
        </p>
      ) : (
        <p id="passkey-hint" className="text-small text-ink-3">
          Face ID, a fingerprint or your device PIN. Nothing to type.
        </p>
      )}
    </div>
  );
}
