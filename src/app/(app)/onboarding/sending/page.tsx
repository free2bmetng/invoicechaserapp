import type { Metadata } from "next";
import { Suspense } from "react";
import { saveOnboardingSendingAction } from "@/app/actions/settings";
import { OnboardingStepHeader, STEP_COPY } from "@/components/settings/onboarding-steps";
import { SendingDomainForm } from "@/components/settings/sending-domain-form";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sending domain · Set up" };

export default function OnboardingSendingPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={2} />}>
      <SendingStep />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function SendingStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <OnboardingStepHeader
        step="sending"
        steps={onboardingSteps(view)}
        title={STEP_COPY.sending.title}
        description="Reminders come from a domain you own. Save it, then add its DNS records where your domain is managed."
      />
      <SendingDomainForm
        initialDomain={view.settings.sendingDomain}
        action={saveOnboardingSendingAction}
        sendingEnabled={view.sendingEnabled}
        submitLabel="Save and continue"
      />
    </div>
  );
}
