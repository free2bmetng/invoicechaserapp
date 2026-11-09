"use client";

import { useActionState, useState, startTransition } from "react";
import { setAutoSendAction } from "@/app/actions/clients";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

// Turning auto-send on releases only the first-reminder hold. Rows marked for approval still wait.
export function AutoSendSwitch({ clientId, autoSend }: { clientId: string; autoSend: boolean }) {
  const [state, dispatch, pending] = useActionState(setAutoSendAction, IDLE_FORM_STATE);
  const [on, setOn] = useState(autoSend);
  const shown = pending ? !on : on;

  function toggle() {
    const next = !shown;
    setOn(next);
    const payload = new FormData();
    payload.set("clientId", clientId);
    payload.set("autoSend", next ? "on" : "off");
    startTransition(() => dispatch(payload));
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p id="autosend-label" className="text-[14px] font-medium text-ink">Send the first reminder without approval</p>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">
            {shown
              ? "On. The first reminder to this client goes out in the send window without waiting for your approval."
              : "Off. The first reminder to this client waits in Needs you until you approve it."}{" "}
            Reminders marked for approval always wait.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-labelledby="autosend-label"
          disabled={pending}
          onClick={toggle}
          className="relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-line-strong bg-surface-2 transition-colors duration-200 aria-checked:border-accent aria-checked:bg-accent focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:opacity-60"
        >
          <span
            aria-hidden="true"
            className={`absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-out ${shown ? "translate-x-5" : ""}`}
          />
        </button>
      </div>
      <p role="status" aria-live="polite" className={state.ok === false ? "text-[13px] text-danger" : "text-[13px] text-ink-2"}>
        {state.message ?? ""}
      </p>
    </div>
  );
}
