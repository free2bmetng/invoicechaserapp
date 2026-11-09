"use client";

// Shared feedback for a list of actions. Success goes to one status line above the list,
// so it stays visible after the acted-on row leaves the list. Errors from controls that sit
// in a compact row go to the same place as an alert; errors from forms stay inline.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { OpsResult } from "@/app/actions/ops";

interface FeedbackApi {
  say(message: string): void;
  fail(message: string): void;
}

const FeedbackContext = createContext<FeedbackApi>({ say: () => undefined, fail: () => undefined });

export function OpsFeedback({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const say = useCallback((text: string) => setMessage({ text, ok: true }), []);
  const fail = useCallback((text: string) => setMessage({ text, ok: false }), []);
  return (
    <FeedbackContext value={{ say, fail }}>
      <div role="status" aria-live="polite" className="empty:hidden">
        {message?.ok ? (
          <p className="mb-5 flex items-start gap-2.5 rounded-[12px] border border-ok/25 bg-ok-soft px-4 py-3 text-body text-ink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mt-0.5 shrink-0 text-ok">
              <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{message.text}</span>
          </p>
        ) : null}
      </div>
      {message && !message.ok ? (
        <p role="alert" className="mb-5 rounded-[12px] border border-danger/25 bg-danger-soft px-4 py-3 text-body text-danger">
          {message.text}
        </p>
      ) : null}
      {children}
    </FeedbackContext>
  );
}

export type OpsAction = (formData: FormData) => Promise<OpsResult>;

// Runs one server action. Returns whether it succeeded. With `banner`, a failure is shown in
// the shared line above the list (for compact rows that have no room for an inline error).
export function useOpsAction({ banner = false }: { banner?: boolean } = {}) {
  const { say, fail } = useContext(FeedbackContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: OpsAction, values: Record<string, string>): Promise<boolean> => {
      setPending(true);
      setError(null);
      const report = (text: string) => (banner ? fail(text) : setError(text));
      try {
        const formData = new FormData();
        for (const [name, value] of Object.entries(values)) formData.set(name, value);
        const result = await action(formData);
        if (result.ok) {
          say(result.message);
          return true;
        }
        report(result.message);
        return false;
      } catch {
        report("Something went wrong. Try again in a moment.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [say, fail, banner],
  );

  return { pending, error, run, clearError: () => setError(null) };
}

export function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-[10px] border border-danger/25 bg-danger-soft px-3 py-2 text-small text-danger">
      {message}
    </p>
  );
}
