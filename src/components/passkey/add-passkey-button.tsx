"use client";

// The add-a-passkey action with its own status line. Reusable: the sign-in offer and the settings
// page's SignInCard addSlot can both render it. Render it only where passkeys are supported.
import { useState } from "react";
import { Button } from "@/components/ui";
import { addPasskeyOnThisDevice } from "./add-passkey";

export function AddPasskeyButton({ onAdded, size = "md" }: { onAdded?: () => void; size?: "sm" | "md" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
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
    <div className="flex flex-col gap-2">
      <Button type="button" variant="primary" size={size} onClick={add} disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Waiting for your device…" : "Add a passkey"}
      </Button>
      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
