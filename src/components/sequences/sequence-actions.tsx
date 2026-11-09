"use client";

import { useActionState } from "react";
import { createSequenceAction, makeDefaultSequenceAction, type ActionNote } from "@/app/actions/sequences";
import { Button } from "@/components/ui";

const IDLE_NOTE: ActionNote = { ok: null, message: null };

export function NewSequenceButton() {
  const [state, formAction, pending] = useActionState(createSequenceAction, IDLE_NOTE);
  return (
    <form action={formAction} className="grid justify-items-end gap-2">
      <Button type="submit" variant="primary" disabled={pending} className="min-h-11 sm:min-h-10">{pending ? "Creating…" : "New sequence"}</Button>
      {state.ok === false && state.message ? <p role="alert" className="text-[13px] text-danger">{state.message}</p> : null}
    </form>
  );
}

export function MakeDefaultButton({ sequenceId }: { sequenceId: string }) {
  const [state, formAction, pending] = useActionState(makeDefaultSequenceAction, IDLE_NOTE);
  return (
    <form action={formAction} className="grid justify-items-start gap-2">
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending} className="min-h-11 sm:min-h-0">{pending ? "Saving…" : "Make default"}</Button>
      {state.message ? (
        <p role={state.ok === false ? "alert" : "status"} className={state.ok === false ? "text-[13px] text-danger" : "text-[13px] text-ink-2"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
