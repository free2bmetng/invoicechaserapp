"use client";

// Account deletion, inline in a red danger zone. There is no modal. The confirm button stays disabled
// until the typed address matches exactly, and the server checks the same thing again before it
// deletes anything.
import { useEffect, useRef, useState } from "react";
import { deleteAccountAction } from "@/app/actions/account";
import { Button, TextInput } from "@/components/ui";
import { Field, fieldProps, Panel, useSettingsForm } from "./form-kit";

export function DeleteAccountCard({ email }: { email: string }) {
  const form = useSettingsForm(deleteAccountAction);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === email;
  const error = form.state.fieldErrors.confirmEmail;
  const openButton = useRef<HTMLButtonElement>(null);
  const formArea = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Focus the confirmation field on open, and return to the button on cancel.
  useEffect(() => {
    if (open) formArea.current?.querySelector<HTMLInputElement>("#confirmEmail")?.focus();
    else if (wasOpen.current) openButton.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <Panel id="delete-account" tone="danger" title="Danger zone">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-body font-medium text-ink">Delete this account</p>
          <p className="text-small text-ink-3">Permanently deletes your account and everything in it. This can&apos;t be undone.</p>
        </div>
        {open ? null : (
          <Button
            ref={openButton}
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-controls="delete-account-form"
            className="shrink-0 border-danger/45! text-danger! hover:bg-danger-soft! max-sm:w-full"
          >
            Delete account
          </Button>
        )}
      </div>
      {open ? (
        <div id="delete-account-form" ref={formArea} className="mt-4 flex flex-col gap-4 border-t border-danger/25 pt-4">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink-2 marker:text-ink-3">
            <li>All clients, invoices, sequences, messages and history are deleted.</li>
            <li>Scheduled and held reminders are cancelled and never sent.</li>
            <li>Your Stripe connection is removed. If Stripe refuses to delete its webhook, you&apos;ll be told how.</li>
            <li>You are signed out, and sign-in links for this address stop working.</li>
          </ul>
          <p className="text-small text-ink-3">Want a copy first? Download your data above.</p>
          <form
            ref={form.formRef}
            onSubmit={form.onSubmit}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !form.pending) setOpen(false);
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            <Field
              id="confirmEmail"
              label="Type your email address to confirm"
              hint={
                <>
                  Type <span className="font-mono break-all text-ink">{email}</span> exactly as shown.
                </>
              }
              error={error}
            >
              <TextInput
                {...fieldProps("confirmEmail", { hasHint: true, error })}
                name="confirmEmail"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-required="true"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="danger"
                  disabled={!matches || form.pending}
                  aria-busy={form.pending || undefined}
                  className="max-sm:flex-1"
                >
                  {form.pending ? "Deleting your account…" : "Delete my account"}
                </Button>
                <Button type="button" variant="ghost" disabled={form.pending} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
              {form.state.message ? (
                <p role="status" className="text-small font-medium text-danger">
                  {form.state.message}
                </p>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </Panel>
  );
}

