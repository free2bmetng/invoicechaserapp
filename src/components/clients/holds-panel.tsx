"use client";

import { useActionState, startTransition } from "react";
import { resumeClientAction, resumeContactAction } from "@/app/actions/clients";
import { Button } from "@/components/ui";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";

export interface HeldContact {
  id: string;
  email: string;
  hold: "bounced" | "paused";
}

// Shown only when something holds this client's reminders. Each hold says what to do next.
export function HoldsPanel({
  clientId,
  repliedLabel,
  heldContacts,
  heldMessageCount,
}: {
  clientId: string;
  // The date of the reply, already formatted in the user's timezone. Null when there was no reply.
  repliedLabel: string | null;
  heldContacts: HeldContact[];
  heldMessageCount: number;
}) {
  const [clientState, clientDispatch, clientPending] = useActionState(resumeClientAction, IDLE_FORM_STATE);
  const [contactState, contactDispatch, contactPending] = useActionState(resumeContactAction, IDLE_FORM_STATE);

  if (!repliedLabel && heldContacts.length === 0) return null;

  return (
    <div role="region" aria-label="Holds" className="grid gap-4 rounded-[var(--radius-lg)] border border-warn/30 bg-warn-soft p-5">
      {repliedLabel ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-warn">On hold since {repliedLabel} after a reply</p>
            <p className="mt-1 text-[14px] leading-6 text-ink-2">
              No reminders go to this client, on any of their invoices, until you resume them.{" "}
              {heldMessageCount === 1 ? "One held reminder waits" : `${heldMessageCount} held reminders wait`} for you.
              Resume once you have dealt with their reply.
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" disabled={clientPending}
            onClick={() => {
              const payload = new FormData();
              payload.set("clientId", clientId);
              startTransition(() => clientDispatch(payload));
            }}>
            {clientPending ? "Resuming…" : "Resume"}
          </Button>
        </div>
      ) : null}

      {heldContacts.map((ct) => (
        <div key={ct.id} className="flex flex-wrap items-start justify-between gap-4 border-t border-warn/20 pt-4">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-warn">
              {ct.hold === "bounced" ? `${ct.email} bounced` : `${ct.email} is paused`}
            </p>
            <p className="mt-1 text-[14px] leading-6 text-ink-2">
              {ct.hold === "bounced"
                ? "Nothing more goes to this address. Change the contact's email above if it is wrong, then resume it."
                : "Reminders to this address are on hold. Resume it when you want them to continue."}
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" disabled={contactPending}
            onClick={() => {
              const payload = new FormData();
              payload.set("contactId", ct.id);
              startTransition(() => contactDispatch(payload));
            }}>
            {contactPending ? "Resuming…" : "Resume this address"}
          </Button>
        </div>
      ))}

      <p role="status" aria-live="polite" className={(clientState.ok === false || contactState.ok === false) ? "text-[13px] text-danger" : "text-[13px] text-ink-2"}>
        {clientState.message ?? contactState.message ?? ""}
      </p>
    </div>
  );
}
