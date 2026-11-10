"use client";

// Sign-in: the passkeys on the account, and the email link that always works. Each passkey row has its
// own inline confirmation for removal. Nothing here is a form-wide edit, so there is no Save.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePasskeySupport } from "@/components/passkey/add-passkey";
import { AddPasskeyButton } from "@/components/passkey/add-passkey-button";
import { SummaryList } from "@/components/data";
import { Button } from "@/components/ui";
import { Panel, StatusLine, useSettingsForm, type FormAction } from "./form-kit";

export interface PasskeyRowView {
  id: string;
  label: string;
  // Formatted on the server in the account's timezone, so the server and browser render the same text.
  lastUsedLabel: string;
}

function KeyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M11.5 12H20m-3 0v3m-3-3v2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function SignInCard({
  passkeys,
  removeAction,
  email,
}: {
  passkeys: PasskeyRowView[];
  removeAction: FormAction;
  email: string;
}) {
  const supported = usePasskeySupport();
  const router = useRouter();

  return (
    <div className="flex flex-col gap-6">
      <Panel
        id="passkeys"
        title="Passkeys"
        description="Sign in with Face ID, a fingerprint or your device PIN. No code to type."
      >
        <div className="flex flex-col gap-4">
          {passkeys.length === 0 ? (
            <p className="text-body text-ink-2">No passkeys yet. Until you add one, you sign in with the email link.</p>
          ) : (
            <ul className="-mx-4 divide-y divide-line border-y border-line sm:-mx-6">
              {passkeys.map((passkey) => (
                <PasskeyRow key={passkey.id} passkey={passkey} removeAction={removeAction} />
              ))}
            </ul>
          )}
          {supported ? (
            <AddPasskeyButton variant={passkeys.length === 0 ? "primary" : "secondary"} onAdded={() => router.refresh()} />
          ) : (
            <p className="text-small text-ink-3">This browser can&apos;t create passkeys. Open Invoice Chaser on your phone or laptop to add one.</p>
          )}
        </div>
      </Panel>

      <Panel id="email-link" title="Email link" description="The way in on a new device, or if you lose the one with your passkey.">
        <SummaryList
          items={[
            { label: "Status", value: "Always on" },
            { label: "Sent to", value: email },
            { label: "Each link", value: "Works once and expires after 15 minutes" },
          ]}
        />
      </Panel>
    </div>
  );
}

function PasskeyRow({ passkey, removeAction }: { passkey: PasskeyRowView; removeAction: FormAction }) {
  const form = useSettingsForm(removeAction);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="px-4 py-3 sm:px-6">
      <div className="flex min-h-11 items-center gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2">
          <KeyIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-ink">{passkey.label}</p>
          <p className="text-small text-ink-3">{passkey.lastUsedLabel}</p>
        </div>
        {confirming ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Remove<span className="sr-only"> {passkey.label}</span>
          </Button>
        )}
      </div>

      {confirming ? (
        <div className="mt-3 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft p-4">
          <p className="text-body text-ink">
            Remove “{passkey.label}”? You won&apos;t be able to sign in with it. The email link still works.
          </p>
          <form ref={form.formRef} onSubmit={form.onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="passkeyId" value={passkey.id} />
            <Button type="submit" variant="danger" disabled={form.pending} aria-busy={form.pending || undefined}>
              {form.pending ? "Removing…" : "Remove passkey"}
            </Button>
            <Button type="button" variant="ghost" disabled={form.pending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <StatusLine state={form.state} />
          </form>
        </div>
      ) : null}
    </li>
  );
}
