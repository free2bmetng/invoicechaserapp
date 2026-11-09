"use client";

// Inline confirmation for destructive actions. It opens in place (no modal, no focus trap).
// Focus moves only when the user opens or closes the panel. Nothing takes focus on mount.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";

export function ConfirmInline({
  trigger,
  question,
  consequence,
  confirmLabel,
  pending,
  onConfirm,
  triggerVariant = "secondary",
}: {
  trigger: string;
  question: string;
  consequence: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  triggerVariant?: "quiet" | "secondary" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const id = useId();

  // Runs only when `open` actually changes. On mount it does nothing, so the trigger
  // never takes focus on load (React's strict-mode effect replay included).
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const root = rootRef.current;
    if (!root) return;
    const target = open
      ? root.querySelector<HTMLButtonElement>("[data-keep]")
      : root.querySelector<HTMLButtonElement>("[data-trigger]");
    target?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      <div>
        {triggerVariant === "quiet" ? (
          <button
            type="button"
            data-trigger
            aria-expanded={open}
            aria-controls={id}
            disabled={pending}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex min-h-11 items-center rounded-[10px] px-3 text-[14px] font-medium text-ink-2 underline-offset-4 transition-colors hover:text-danger hover:underline focus-visible:text-danger focus-visible:underline disabled:opacity-50"
          >
            {trigger}
          </button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={triggerVariant}
            data-trigger
            aria-expanded={open}
            aria-controls={id}
            disabled={pending}
            onClick={() => setOpen((value) => !value)}
          >
            {trigger}
          </Button>
        )}
      </div>
      {open ? (
        <div id={id} role="group" aria-labelledby={`${id}-question`} className="rounded-[12px] border border-danger/30 bg-danger-soft p-4">
          <p id={`${id}-question`} className="text-[14px] font-semibold text-ink">
            {question}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">{consequence}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
            <Button type="button" size="sm" variant="secondary" data-keep disabled={pending} onClick={() => setOpen(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
