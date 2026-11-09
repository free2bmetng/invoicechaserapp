"use client";

// Passkey sign-in on the login screen. It renders nothing where the browser has no WebAuthn support,
// so the email link stays the only option there.
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useState } from "react";
import { isCancelled, usePasskeySupport } from "@/components/passkey/add-passkey";
import { Button } from "@/components/ui";

const FAILED = "We could not sign you in with that passkey. Use the email link below.";
const CANCELLED = "Passkey sign-in was cancelled. You can still use the email link below.";
const RATE_LIMITED = "Too many attempts. Wait a few minutes, or use the email link below.";

export function PasskeySignIn() {
  const supported = usePasskeySupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!supported) return null;

  async function signIn() {
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
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Button type="button" variant="primary" className="w-full" onClick={signIn} disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Waiting for your device…" : "Sign in with a passkey"}
        </Button>
        <p className="text-[13px] leading-5 text-ink-3">Use Face ID, a fingerprint or your device PIN. There is no code to type.</p>
        {error ? (
          <p role="alert" className="text-[13px] leading-5 text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3 text-[12px] font-medium tracking-[0.08em] text-ink-3 uppercase" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
