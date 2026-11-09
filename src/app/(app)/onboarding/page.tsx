import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui";
import { Callout } from "@/components/settings/form-kit";
import { FinishOnboardingForm } from "@/components/settings/finish-onboarding-form";
import { OnboardingProgress } from "@/components/settings/onboarding-steps";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, missingRequiredSteps, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export default function OnboardingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="Set up Invoice Chaser"
        description="Four steps. Reminders are planned only after steps 1, 2 and 4 are complete."
      />
      <Suspense fallback={<CardsSkeleton cards={2} />}>
        <OnboardingOverview />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function OnboardingOverview() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const steps = onboardingSteps(view);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <OnboardingProgress steps={steps} />
      <div>
        {view.settings.onboardingDone ? (
          <Callout tone="info">
            <p className="font-medium">Setup is complete.</p>
            <p className="mt-1">
              Reminders are planned for your open invoices.{" "}
              <Link className="underline underline-offset-4 hover:text-ink-2" href="/">
                Go to the dashboard
              </Link>
              .
            </p>
          </Callout>
        ) : (
          <FinishOnboardingForm missing={missingRequiredSteps(steps)} />
        )}
      </div>
    </div>
  );
}
