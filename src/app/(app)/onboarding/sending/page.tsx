import { Suspense } from "react";
import { saveOnboardingSendingAction } from "@/app/actions/settings";
import { PageHeader } from "@/components/ui";
import { SettingsCard } from "@/components/settings/form-kit";
import { OnboardingProgress } from "@/components/settings/onboarding-steps";
import { SendingDomainForm } from "@/components/settings/sending-domain-form";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export default function OnboardingSendingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Setup · Step 2 of 4"
        title="Connect sending"
        description="Reminders need a domain you own. Save it here, then set up its DNS records as shown."
      />
      <Suspense fallback={<CardsSkeleton cards={1} />}>
        <SendingStep />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function SendingStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <OnboardingProgress steps={onboardingSteps(view)} current="sending" />
      <div>
        <SettingsCard
          id="sending-domain"
          title="Your sending domain"
          description={
            <p>The app cannot check your DNS records or where mail ends up, so it never reports a record as live.</p>
          }
        >
          <SendingDomainForm
            initialDomain={view.settings.sendingDomain}
            action={saveOnboardingSendingAction}
            sendingEnabled={view.sendingEnabled}
            submitLabel="Save and continue"
          />
        </SettingsCard>
      </div>
    </div>
  );
}
