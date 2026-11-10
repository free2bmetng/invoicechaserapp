import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui";
import { OnboardingChecklist } from "@/components/settings/onboarding-steps";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, nextOnboardingStep, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Set up" };

export default function OnboardingPage() {
  return (
    <>
      <PageHeader
        title="Set up Invoice Chaser"
        description="A few minutes now, and overdue invoices get chased politely from then on. Nothing is sent until you finish."
      />
      <div className="mt-8 max-w-3xl">
        <Suspense fallback={<CardsSkeleton cards={1} />}>
          <OnboardingOverview />
        </Suspense>
      </div>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function OnboardingOverview() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const steps = onboardingSteps(view);
  return <OnboardingChecklist steps={steps} next={nextOnboardingStep(steps, view.settings.onboardingDone)} />;
}
