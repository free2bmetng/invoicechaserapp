import { Suspense } from "react";
import { DateTime } from "luxon";
import { removePasskeyAction, saveSendingDomainAction } from "@/app/actions/settings";
import { AddPasskeyButton } from "@/components/passkey/add-passkey-button";
import { SignInCard, type PasskeyRowView } from "@/components/settings/sign-in-card";
import { listPasskeys } from "@/lib/passkeys";
import { PageHeader } from "@/components/ui";
import { Callout, SettingsCard } from "@/components/settings/form-kit";
import { DataCard } from "@/components/settings/data-card";
import { DeleteAccountCard } from "@/components/settings/delete-account-card";
import { LatePaymentTermsCard } from "@/components/settings/late-terms-card";
import { SendingDomainForm } from "@/components/settings/sending-domain-form";
import { SenderSettingsForm } from "@/components/settings/sender-settings-form";
import { SettingsNav, SettingsSection } from "@/components/settings/settings-nav";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { StripeCard } from "@/components/settings/stripe-card";
import { requireUserId } from "@/lib/session";
import { getSettingsView, type SettingsView } from "@/lib/queries/settings";
import { isSenderProfileComplete } from "@/lib/templates";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Who reminders come from, when they go out, and how you get paid. Each section with fields to change ends with its own Save."
      />
      <Suspense fallback={<CardsSkeleton cards={6} />}>
        <SettingsBody />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function SettingsBody() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const s = view.settings;
  const profileDone = isSenderProfileComplete({
    senderName: s.senderName,
    businessName: s.businessName,
    postalAddress: s.postalAddress,
  });
  // Formatted here, in the account's timezone, so the server and the browser show the same dates.
  const passkeys: PasskeyRowView[] = (await listPasskeys(userId)).map((passkey) => ({
    id: passkey.id,
    label: passkey.label,
    lastUsedLabel: passkey.lastUsedAt
      ? `Last used ${DateTime.fromJSDate(passkey.lastUsedAt, { zone: s.timezone }).toFormat("d LLL yyyy")}`
      : "Not used yet",
  }));

  return (
    <>
      {!profileDone ? (
        <div className="mt-8 max-w-3xl">
          <Callout tone="warn">
            <p className="font-medium">Reminders are off until your sender details are complete.</p>
            <p className="mt-1">
              Add your name, business name and postal address below. Until all three are filled in, no reminder can be
              created or sent.
            </p>
          </Callout>
        </div>
      ) : null}

      <div className="mt-8 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-12">
        <SettingsNav />

        <div className="mt-8 flex min-w-0 flex-col gap-12 lg:mt-0">
          <SettingsSection
            id="sender"
            title="Sender"
            description="Who reminders come from, and when they go out. The footer on every reminder is built from your sender details."
          >
            <SenderSettingsForm
              initial={{
                senderName: s.senderName,
                businessName: s.businessName,
                postalAddress: s.postalAddress,
                timezone: s.timezone,
                windowStart: String(s.sendWindowStart),
                windowEnd: String(s.sendWindowEnd),
                dailyCap: String(s.dailyCap),
                digestEnabled: s.digestEnabled,
                digestHour: String(s.digestHour),
              }}
            />
          </SettingsSection>

          <SettingsSection
            id="sending"
            title="Sending"
            description="The domain reminders are sent from, and the DNS records that prove you own it."
          >
            <SettingsCard
              id="sending-domain"
              level={3}
              title="Sending domain"
              description={
                <p>The app cannot check your DNS records or where mail ends up, so it never reports a record as live.</p>
              }
            >
              <SendingDomainForm
                initialDomain={s.sendingDomain}
                action={saveSendingDomainAction}
                sendingEnabled={view.sendingEnabled}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            id="sign-in"
            title="Sign-in"
            description="How you sign in. A passkey is the everyday way in. The email link is the fallback for new devices."
          >
            <SignInCard passkeys={passkeys} removeAction={removePasskeyAction} addSlot={<AddPasskeyButton />} />
          </SettingsSection>

          <SettingsSection
            id="payments"
            title="Payments"
            description="Optional. Connect Stripe to add a payment link to each reminder."
          >
            <StripeCard
              connected={view.stripe.connected}
              accountLabel={view.stripe.accountLabel}
              appUrlConfigured={view.appUrlConfigured}
              oauthConfigured={view.stripeOauthConfigured}
              restrictedKeyMode={view.stripeRestrictedKeyMode}
            />
          </SettingsSection>

          <SettingsSection id="terms" title="Terms" description="Wording you can copy into your own invoices.">
            <LatePaymentTermsCard />
          </SettingsSection>

          <SettingsSection
            id="account"
            title="Account"
            description="Your data and your account. Deleting the account cannot be undone."
          >
            <DataCard />
            <DeleteAccountCard email={view.email} />
          </SettingsSection>

          <SetupNote view={view} />
        </div>
      </div>
    </>
  );
}

// A short line at the end for the one state the cards do not explain themselves.
function SetupNote({ view }: { view: SettingsView }) {
  if (view.settings.onboardingDone) return null;
  return (
    <p className="max-w-3xl border-t border-line pt-6 text-[13.5px] leading-6 text-ink-3">
      Setup is not finished yet.{" "}
      <a className="underline underline-offset-4 hover:text-ink" href="/onboarding">
        Open setup
      </a>{" "}
      to see the remaining steps.
    </p>
  );
}
