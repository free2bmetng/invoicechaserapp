"use client";

// Sign-in: the passkeys on the account. Each row has its own inline confirmation for removal. There is
// no form-wide Save here, because nothing is edited: a passkey is added or removed on its own.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { readableDisabled, SettingsCard, StatusLine, useSettingsForm, type FormAction } from "./form-kit";

export interface PasskeyRowView {
  id: string;
  label: string;
  // Formatted on the server in the account's timezone, so the server and browser render the same text.
  lastUsedLabel: string;
}

// True when this browser exposes the WebAuthn API that passkeys need. Read after mount only, so the
// server render and the first browser render match.
function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

export function SignInCard({
  passkeys,
  removeAction,
  addSlot,
}: {
  passkeys: PasskeyRowView[];
  removeAction: FormAction;
  // The add-a-passkey flow (the passkey feature's PasskeyOffer). Shown only in browsers that support passkeys.
  addSlot?: ReactNode;
}) {
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(browserSupportsPasskeys()), []);

  return (
    <SettingsCard
      id="passkeys"
      level={3}
      title="Passkeys"
      description={
        <p>
          Sign in with Face ID, a fingerprint or a device PIN. The email link is for new devices, and it still works if you
          remove every passkey.
        </p>
      }
    >
      <div className="flex flex-col gap-5">
        {passkeys.length === 0 ? (
          <p className="text-[14px] leading-6 text-ink-2">
            No passkeys on this account yet. Until you add one, sign in with the email link.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-md)] border border-line">
            {passkeys.map((passkey) => (
              <PasskeyRow key={passkey.id} passkey={passkey} removeAction={removeAction} />
            ))}
          </ul>
        )}

        {supported && addSlot ? <div className="border-t border-line pt-5">{addSlot}</div> : null}
      </div>
    </SettingsCard>
  );
}

function PasskeyRow({ passkey, removeAction }: { passkey: PasskeyRowView; removeAction: FormAction }) {
  const form = useSettingsForm(removeAction);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-ink">{passkey.label}</p>
          <p className="text-[13px] text-ink-3">{passkey.lastUsedLabel}</p>
        </div>
        {confirming ? null : (
          <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>

      {confirming ? (
        <div className="mt-4 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft p-4">
          <p className="text-[14px] leading-6 text-ink">
            Remove “{passkey.label}”? You will not be able to sign in with it anymore. Removing your last passkey is fine:
            the email link still signs you in.
          </p>
          <form ref={form.formRef} onSubmit={form.onSubmit} className="mt-4 flex flex-wrap items-center gap-2">
            <input type="hidden" name="passkeyId" value={passkey.id} />
            <Button
              type="submit"
              variant="danger"
              disabled={form.pending}
              aria-busy={form.pending || undefined}
              className={readableDisabled}
            >
              {form.pending ? "Removing…" : "Yes, remove it"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={form.pending}
              onClick={() => setConfirming(false)}
              className={readableDisabled}
            >
              Keep it
            </Button>
          </form>
          <div className="mt-3">
            <StatusLine state={form.state} />
          </div>
        </div>
      ) : null}
    </li>
  );
}
