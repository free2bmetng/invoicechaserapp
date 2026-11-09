"use client";

// Shared feedback for a list of actions. Success goes to one status line above the list,
// so it stays visible after the acted-on card leaves the list. Errors stay inline on the
// card, next to the control that failed.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { OpsResult } from "@/app/actions/ops";

interface FeedbackApi {
  say(message: string): void;
}

const FeedbackContext = createContext<FeedbackApi>({ say: () => undefined });

export function OpsFeedback({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const say = useCallback((next: string) => setMessage(next), []);
  return (
    <FeedbackContext value={{ say }}>
      <p
        role="status"
        aria-live="polite"
        className="mb-5 flex items-start gap-2.5 rounded-[12px] border border-ok/25 bg-ok-soft px-4 py-3 text-[14px] leading-6 text-ink empty:hidden"
      >
        {message ? (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mt-0.5 shrink-0 text-ok">
              <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{message}</span>
          </>
        ) : null}
      </p>
      {children}
    </FeedbackContext>
  );
}

export type OpsAction = (formData: FormData) => Promise<OpsResult>;

// Runs one server action for one card. Returns whether it succeeded.
export function useOpsAction() {
  const { say } = useContext(FeedbackContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: OpsAction, values: Record<string, string>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const formData = new FormData();
        for (const [name, value] of Object.entries(values)) formData.set(name, value);
        const result = await action(formData);
        if (result.ok) {
          say(result.message);
          return true;
        }
        setError(result.message);
        return false;
      } catch {
        setError("Something went wrong. Try again in a moment.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [say],
  );

  return { pending, error, run, clearError: () => setError(null) };
}

export function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-[10px] border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] leading-5 text-danger">
      {message}
    </p>
  );
}
