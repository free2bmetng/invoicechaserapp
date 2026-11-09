"use client";

// Payments with Stripe. The usual way in is Connect with Stripe: the user approves access on Stripe's own
// page, and no key is pasted here. The restricted-key form exists only for internal testing, and only when
// the installation sets STRIPE_KEY_MODE=restricted. Either way the screen shows the account label only.
import { useEffect, useState } from "react";
import { updateStripeConnectionAction } from "@/app/actions/settings";
import { Badge, Button, TextInput } from "@/components/ui";
import {
  Callout,
  Field,
  fieldProps,
  readableDisabled,
  SaveBar,
  SettingsCard,
  StatusLine,
  useSettingsForm,
} from "./form-kit";

// The same look as the primary button, for a plain link (the connect route is a full page navigation).
const CONNECT_BUTTON =
  "lift inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-accent px-4 text-sm font-medium whitespace-nowrap text-accent-ink select-none shadow-[0_1px_0_rgb(255_255_255/0.18)_inset,0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover";

export function StripeCard({
  connected,
  accountLabel,
  appUrlConfigured,
  oauthConfigured,
  restrictedKeyMode,
}: {
  connected: boolean;
  // The account label or Stripe account id. Never a token or a key.
  accountLabel: string | null;
  appUrlConfigured: boolean;
  // True when STRIPE_CONNECT_CLIENT_ID is set, so the Connect with Stripe flow can start.
  oauthConfigured: boolean;
  // True only when STRIPE_KEY_MODE=restricted: the internal-testing key form is offered.
  restrictedKeyMode: boolean;
}) {
  const form = useSettingsForm(updateStripeConnectionAction);
  const [stripeKey, setStripeKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const errors = form.state.fieldErrors;

  // Clear the typed key once it has been used, and close the confirmation once the disconnect ran.
  useEffect(() => {
    if (form.state.status === "saved" || form.state.status === "warning") {
      setStripeKey("");
      setConfirming(false);
    }
  }, [form.state]);

  return (
    <SettingsCard
      id="stripe"
      level={3}
      title="Payments with Stripe (optional)"
      description={
        <p>
          With Stripe connected, each reminder includes a payment link, and the money goes straight to your Stripe account.
          Invoice Chaser never holds, routes or pays out money. Without Stripe, you mark invoices paid by hand and reminders
          carry no link.
        </p>
      }
    >
      {/* Above the branch, so a disconnect warning survives the switch to "not connected". */}
      {form.state.status === "warning" ? (
        <div className="mb-5">
          <Callout tone="warn">{form.state.message}</Callout>
        </div>
      ) : null}

      {connected ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="ok">Connected</Badge>
            <span className="text-[14px] text-ink-2">
              Account: <span className="font-medium text-ink">{accountLabel ?? "Stripe account"}</span>
            </span>
          </div>

          {form.state.status !== "warning" ? <StatusLine state={form.state} /> : null}

          {confirming ? (
            <div className="rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft p-4">
              <p className="text-[14px] leading-6 text-ink">
                Disconnecting removes Stripe from Invoice Chaser. New reminders stop carrying a payment link. Invoice Chaser
                also tries to delete the Stripe webhook endpoint. If Stripe refuses, you will be told how to delete it
                yourself.
              </p>
              <form ref={form.formRef} onSubmit={form.onSubmit} className="mt-4 flex flex-wrap gap-2">
                <input type="hidden" name="intent" value="disconnect" />
                <Button
                  type="submit"
                  variant="danger"
                  disabled={form.pending}
                  aria-busy={form.pending || undefined}
                  className={readableDisabled}
                >
                  {form.pending ? "Disconnecting…" : "Yes, disconnect Stripe"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={form.pending}
                  onClick={() => setConfirming(false)}
                  className={readableDisabled}
                >
                  Keep it connected
                </Button>
              </form>
            </div>
          ) : (
            <div>
              <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
                Disconnect Stripe
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <p className="text-[14px] leading-6 text-ink-2">
              You approve Invoice Chaser on Stripe&apos;s own page, and no key is pasted here.
            </p>
            {oauthConfigured ? (
              <div>
                <a href="/api/stripe/connect" className={CONNECT_BUTTON}>
                  Connect with Stripe
                </a>
              </div>
            ) : (
              <>
                <Callout tone="info">
                  Stripe is not set up on this installation yet. Connecting needs the Stripe Connect client ID, which the
                  person who runs Invoice Chaser adds as STRIPE_CONNECT_CLIENT_ID.
                </Callout>
                <div>
                  <button type="button" disabled className={`${CONNECT_BUTTON} ${readableDisabled}`}>
                    Connect with Stripe
                  </button>
                </div>
              </>
            )}
          </div>

          {restrictedKeyMode ? (
            <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-5 border-t border-line pt-6">
              <input type="hidden" name="intent" value="connect" />
              <div className="flex flex-col gap-2">
                <Badge tone="warn">Internal testing only</Badge>
                <p className="text-[14px] leading-6 text-ink-2">
                  Paste a restricted key directly. This form is for internal testing on this installation, not for customers.
                </p>
              </div>
              <Field
                id="stripeKey"
                label="Restricted API key"
                hint={
                  <>
                    Starts with <span className="font-mono">rk_</span>. Create it in Stripe with permission to write Webhook
                    Endpoints, and to read and write Payment Links and Prices. Secret keys (sk_) are not accepted. The key is
                    encrypted when saved and never shown again.
                  </>
                }
                error={errors.stripeKey}
              >
                <TextInput
                  {...fieldProps("stripeKey", { hasHint: true, error: errors.stripeKey })}
                  name="stripeKey"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-required="true"
                  className="font-mono"
                  value={stripeKey}
                  onChange={(e) => setStripeKey(e.target.value)}
                />
              </Field>

              {!appUrlConfigured ? (
                <Callout tone="warn">
                  This installation has no APP_URL set, so Stripe cannot send payment events back yet. Ask the person who runs
                  Invoice Chaser to set it.
                </Callout>
              ) : null}

              <SaveBar
                pending={form.pending}
                state={form.state}
                idleLabel="Connect with a restricted key"
                pendingLabel="Checking the key with Stripe…"
                disabled={!appUrlConfigured}
                showStatus={form.state.status !== "warning"}
              />
            </form>
          ) : null}

          {!restrictedKeyMode && form.state.status !== "warning" ? <StatusLine state={form.state} /> : null}
        </div>
      )}
    </SettingsCard>
  );
}
