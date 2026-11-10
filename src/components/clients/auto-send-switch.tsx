"use client";

import { useActionState, useState, startTransition } from "react";
import { setAutoSendAction } from "@/app/actions/clients";
import { Card, Switch } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

// Turning auto-send on releases only the first-reminder hold. Steps marked for approval still wait.
export function AutoSendSwitch({ clientId, autoSend }: { clientId: string; autoSend: boolean }) {
  const [state, dispatch, pending] = useActionState(setAutoSendAction, IDLE_FORM_STATE);
  const [on, setOn] = useState(autoSend);

  function toggle(next: boolean) {
    setOn(next);
    const payload = new FormData();
    payload.set("clientId", clientId);
    payload.set("autoSend", next ? "on" : "off");
    startTransition(() => dispatch(payload));
  }

  return (
    <Card as="section" className="px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
      <h2 className="text-card-title text-ink">Auto-send</h2>
      <div className="mt-1">
        <Switch
          id="client-autosend"
          label="Send the first reminder without approval"
          description={on
            ? "On. The first reminder goes out in the send window. Steps marked for approval still wait."
            : "Off. The first reminder waits in Needs you until you approve it."}
          checked={on}
          disabled={pending}
          onChange={toggle}
        />
      </div>
      <p role="status" aria-live="polite" className={state.ok === false ? "text-small text-danger" : "sr-only"}>
        {state.message ?? ""}
      </p>
    </Card>
  );
}
