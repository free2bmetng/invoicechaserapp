"use client";

// The add-a-passkey action with its own status line. Reusable: the sign-in offer and the settings
// Sign-in page both render it. Render it only where passkeys are supported.
// While the device prompt is open the button is aria-disabled rather than disabled, so keyboard
// focus stays on it instead of falling back to the page.
import { useState } from "react";
import { Button } from "@/components/ui";
import { addPasskeyOnThisDevice } from "./add-passkey";

export function AddPasskeyButton({
  onAdded,
  size = "md",
  variant = "primary",
}: {
  onAdded?: () => void;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await addPasskeyOnThisDevice();
    setBusy(false);
    if (result.ok) {
      onAdded?.();
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={add}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className={busy ? "cursor-progress opacity-70" : undefined}
      >
        {busy ? "Waiting for your device…" : "Add a passkey"}
      </Button>
      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
