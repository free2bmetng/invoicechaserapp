"use client";

import { useActionState } from "react";
import {
  createSequenceAction, duplicateSequenceAction, makeDefaultSequenceAction, type ActionNote,
} from "@/app/actions/sequences";
import { Button } from "@/components/ui";

const IDLE_NOTE: ActionNote = { ok: null, message: null };

export function NewSequenceButton() {
  const [state, formAction, pending] = useActionState(createSequenceAction, IDLE_NOTE);
  return (
    <form action={formAction} className="grid justify-items-start gap-2 md:justify-items-end">
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "New sequence"}</Button>
      {state.ok === false && state.message ? <p role="alert" className="text-small text-danger">{state.message}</p> : null}
    </form>
  );
}

// Copies the sequence and opens the copy. The copy is never the default.
export function DuplicateButton({ sequenceId, name, variant = "ghost" }: { sequenceId: string; name: string; variant?: "ghost" | "secondary" }) {
  const [state, formAction, pending] = useActionState(duplicateSequenceAction, IDLE_NOTE);
  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <Button type="submit" variant={variant} size="sm" disabled={pending} aria-label={`Duplicate ${name}`}>
        {pending ? "Copying…" : "Duplicate"}
      </Button>
      {state.ok === false && state.message ? <p role="alert" className="basis-full text-small text-danger">{state.message}</p> : null}
    </form>
  );
}

export function MakeDefaultButton({ sequenceId, name }: { sequenceId: string; name?: string }) {
  const [state, formAction, pending] = useActionState(makeDefaultSequenceAction, IDLE_NOTE);
  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={name ? `Make ${name} the default` : undefined}>
        {pending ? "Saving…" : "Make default"}
      </Button>
      {state.message ? (
        <p role={state.ok === false ? "alert" : "status"} className={state.ok === false ? "basis-full text-small text-danger" : "basis-full text-small text-ink-2"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
