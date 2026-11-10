"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass, cx } from "@/components/ui";

const RESET_AFTER_MS = 2000;

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.5 5.5v-.3A1.7 1.7 0 0 0 13.8 3.5H6.2A1.7 1.7 0 0 0 4.5 5.2v7.6a1.7 1.7 0 0 0 1.7 1.7h.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Copies one value to the clipboard. The button's accessible name stays "Copy <what>", and a polite
// live region announces the result, so screen readers hear it without a focus change.
// "icon": a 44px square (records tables). "text": a secondary button with the icon and a word.
export function CopyButton({
  value,
  label,
  variant = "icon",
  text = "Copy",
}: {
  value: string;
  label: string;
  variant?: "icon" | "text";
  text?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), RESET_AFTER_MS);
  }

  const icon = state === "copied" ? <CheckIcon /> : <CopyIcon />;

  return (
    <span className="inline-flex shrink-0 items-center">
      {variant === "icon" ? (
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          title={state === "copied" ? "Copied" : "Copy"}
          className={cx(
            "grid size-11 shrink-0 place-items-center rounded-[10px] border transition-colors duration-150",
            state === "copied"
              ? "border-ok/30 bg-ok-soft text-ok"
              : "border-line bg-surface text-ink-2 hover:border-control-border hover:bg-surface-2 hover:text-ink",
          )}
        >
          {icon}
        </button>
      ) : (
        <button type="button" onClick={copy} aria-label={label} className={buttonClass("secondary")}>
          {icon}
          {state === "copied" ? "Copied" : text}
        </button>
      )}
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
