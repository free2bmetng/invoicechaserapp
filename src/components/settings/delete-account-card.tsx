"use client";

// Account deletion, inline. There is no modal. The button stays disabled until the typed address
// matches exactly, and the server checks the same thing again before it deletes anything.
import { useState } from "react";
import { deleteAccountAction } from "@/app/actions/account";
import { TextInput } from "@/components/ui";
import { Field, fieldProps, SaveBar, SettingsCard, useSettingsForm } from "./form-kit";

export function DeleteAccountCard({ email }: { email: string }) {
  const form = useSettingsForm(deleteAccountAction);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === email;
  const error = form.state.fieldErrors.confirmEmail;

  return (
    <SettingsCard
      id="delete-account"
      level={3}
      title="Delete account"
      description={<p>This permanently deletes your Invoice Chaser account. It cannot be undone.</p>}
    >
      <div className="flex flex-col gap-5">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] leading-6 text-ink-2 marker:text-ink-3">
          <li>All clients, invoices, reminder sequences, messages, the message log and events are deleted.</li>
          <li>Reminders that are scheduled, held or waiting for your approval are cancelled and never sent.</li>
          <li>
            Your Stripe key is deleted, and Invoice Chaser tries to delete the Stripe webhook endpoint. If Stripe refuses,
            you will need to delete the endpoint in Stripe yourself.
          </li>
          <li>You are signed out, and sign-in links for this address stop working.</li>
        </ul>

        <p className="text-[14px] leading-6 text-ink-2">If you want a copy of your data, download it first, above.</p>

        <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-5">
          <Field
            id="confirmEmail"
            label="Type your email address to confirm"
            hint={
              <>
                Type <span className="font-mono break-all text-ink">{email}</span> exactly as shown. Capital letters
                count.
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

          <SaveBar
            pending={form.pending}
            state={form.state}
            idleLabel="Delete my account"
            pendingLabel="Deleting your account…"
            disabled={!matches}
            danger
          />
        </form>
      </div>
    </SettingsCard>
  );
}
