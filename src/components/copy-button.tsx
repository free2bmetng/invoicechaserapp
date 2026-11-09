"use client";

import { useEffect, useRef, useState } from "react";

const RESET_AFTER_MS = 2000;

// Enabled: a soft accent fill that reads as a button. Disabled: a dashed outline with muted text and a
// not-allowed cursor, so it cannot be mistaken for a live control.
const ENABLED =
  "border-accent/30 bg-accent-soft text-accent hover:border-accent/50 hover:bg-accent-soft/70";
const DISABLED = "cursor-not-allowed border-dashed border-line-strong bg-transparent text-ink-3";

// Copies one value to the clipboard. The button's accessible name stays "Copy <what>", and a
// polite live region announces the result, so screen readers hear it without a focus change.
// disabled is used when the app does not yet know the value, so there is nothing honest to copy.
export function CopyButton({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), RESET_AFTER_MS);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        disabled={disabled}
        className={`inline-flex h-8 shrink-0 items-center rounded-[10px] border px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
          disabled ? DISABLED : ENABLED
        }`}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? `${label}: copied.` : state === "failed" ? "Copying did not work. Select the text and copy it by hand." : ""}
      </span>
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
