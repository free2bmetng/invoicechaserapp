"use client";

// A calm, dismissible card shown once after a magic-link sign-in. It is not a modal, and nothing blocks
// the page underneath. Dismissal is remembered in a cookie, not in the database.
import { useState } from "react";
import { Button } from "@/components/ui";
import { PASSKEY_DISMISSED_COOKIE, PASSKEY_DISMISSED_MAX_AGE_SECONDS } from "@/lib/passkey-offer";
import { usePasskeySupport } from "./add-passkey";
import { AddPasskeyButton } from "./add-passkey-button";

export function PasskeyOffer() {
  const supported = usePasskeySupport();
  const [hidden, setHidden] = useState(false);
  const [added, setAdded] = useState(false);

  if (!supported || hidden) return null;

  function dismiss() {
    rememberDismissal();
    setHidden(true);
  }

  return (
    <section
      aria-labelledby="passkey-offer-title"
      className="mb-6 rounded-[var(--radius-lg)] border border-accent/25 bg-accent-soft p-5 shadow-card"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 id="passkey-offer-title" className="text-[15px] leading-6 font-semibold text-ink">
            Sign in faster next time.
          </h2>
          {added ? (
            <p role="status" className="mt-1 text-[14px] leading-6 text-ink-2">
              Passkey added. Next time, Face ID, a fingerprint or your device PIN is all you need.
            </p>
          ) : (
            <p className="mt-1 text-[14px] leading-6 text-ink-2">Add a passkey for this device.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {added ? (
            <Button type="button" variant="secondary" size="sm" onClick={dismiss}>
              Done
            </Button>
          ) : (
            <>
              <AddPasskeyButton size="sm" onAdded={() => setAdded(true)} />
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                Not now
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Writes the dismissal cookie. If cookies are blocked the card still hides for this page view.
function rememberDismissal(): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${PASSKEY_DISMISSED_COOKIE}=1; Max-Age=${PASSKEY_DISMISSED_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Nothing else to do: the card is hidden for this view.
  }
}
