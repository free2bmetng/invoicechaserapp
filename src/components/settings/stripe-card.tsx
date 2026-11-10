"use client";

// Payments with Stripe. The usual way in is Connect with Stripe: the user approves access on Stripe's own
// page, and no key is pasted here. The restricted-key form exists only for internal testing, and only when
// the installation turns it on. Either way the screen shows the account label only, never a key.
import { useEffect, useState } from "react";
import { updateStripeConnectionAction } from "@/app/actions/settings";
import { SummaryList } from "@/components/data";
import { Badge, Button, buttonClass, TextInput } from "@/components/ui";
import { Callout, Field, fieldProps, FormActions, Panel, StatusLine, useSettingsForm } from "./form-kit";

export interface StripeNotice {
  tone: "ok" | "danger";
  message: string;
}

export function StripeCard({
  connected,
  accountLabel,
  appUrlConfigured,
  oauthConfigured,
  restrictedKeyMode,
  notice,
}: {
  connected: boolean;
  // The account label or Stripe account id. Never a token or a key.
  accountLabel: string | null;
  appUrlConfigured: boolean;
  // True when this installation can start the Connect with Stripe flow.
  oauthConfigured: boolean;
  // True only when the internal-testing key form is turned on.
  restrictedKeyMode: boolean;
  // The result of a Connect with Stripe return, if the page was opened from one.
  notice: StripeNotice | null;
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

  const showNotice = notice && form.state.status === "idle";

  return (
    <div className="flex flex-col gap-6">
      {showNotice ? (
        <Callout tone={notice.tone === "ok" ? "neutral" : "danger"}>
          <p role="status" className={notice.tone === "ok" ? "font-medium text-ok" : "font-medium text-danger"}>
            {notice.message}
          </p>
        </Callout>
      ) : null}
      {/* Above the panel, so a disconnect warning survives the switch to "not connected". */}
      {form.state.status === "warning" ? <Callout tone="warn">{form.state.message}</Callout> : null}

      <Panel
        id="stripe"
        title="Stripe"
        description="With Stripe connected, each reminder carries a payment link and the money goes straight to your Stripe account. Invoice Chaser never holds money."
        action={
          connected && !confirming ? (
            <Button type="button" size="sm" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <SummaryList
            items={[
              {
                label: "Status",
                value: connected ? <Badge tone="ok">Connected</Badge> : <Badge>Not connected</Badge>,
              },
              connected
                ? { label: "Account", value: accountLabel ?? "Stripe account" }
                : { label: "Without Stripe", value: "You mark invoices paid by hand, and reminders carry no payment link." },
            ]}
          />

          {connected && confirming ? (
            <div className="rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft p-4">
              <p className="text-body text-ink">
                New reminders will stop carrying a payment link. Invoice Chaser also deletes its Stripe webhook, or tells
                you how to if Stripe refuses.
              </p>
              <form ref={form.formRef} onSubmit={form.onSubmit} className="mt-3 flex flex-wrap gap-2">
                <input type="hidden" name="intent" value="disconnect" />
                <Button type="submit" variant="danger" disabled={form.pending} aria-busy={form.pending || undefined}>
                  {form.pending ? "Disconnecting…" : "Disconnect Stripe"}
                </Button>
                <Button type="button" variant="ghost" disabled={form.pending} onClick={() => setConfirming(false)}>
                  Keep it connected
                </Button>
              </form>
            </div>
          ) : null}

          {!connected ? (
            oauthConfigured ? (
              <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
                <a href="/api/stripe/connect" className={buttonClass("primary")}>
                  Connect with Stripe
                </a>
                <p className="text-small text-ink-3">You approve access on Stripe&apos;s own page. No key is pasted here.</p>
              </div>
            ) : (
              <p className="border-t border-line pt-4 text-body text-ink-2">
                Stripe isn&apos;t set up on this installation yet. Ask the person who runs Invoice Chaser to turn it on.
              </p>
            )
          ) : null}

          {/* The key form shows its own status while it is on screen. */}
          {(form.state.status === "saved" || form.state.status === "error") && !(restrictedKeyMode && !connected) ? (
            <StatusLine state={form.state} />
          ) : null}
        </div>
      </Panel>

      {restrictedKeyMode && !connected ? (
        <Panel
          id="stripe-key"
          title="Restricted key"
          description="For internal testing on this installation only. Customers connect with Stripe instead."
          action={<Badge tone="warn">Internal testing</Badge>}
        >
          <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="connect" />
            <Field
              id="stripeKey"
              label="Restricted API key"
              hint={
                <>
                  Starts with <span className="font-mono">rk_</span>. Needs write access to Webhook Endpoints, and read and
                  write access to Payment Links and Prices. Stored encrypted and never shown again.
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
                This installation&apos;s web address isn&apos;t set, so Stripe can&apos;t send payment events back yet.
              </Callout>
            ) : null}
            <FormActions
              pending={form.pending}
              state={form.state.status === "warning" ? { ...form.state, message: "" } : form.state}
              idleLabel="Connect with this key"
              pendingLabel="Checking the key with Stripe…"
              disabled={!appUrlConfigured}
              cancel={false}
            />
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
