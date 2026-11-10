import type { Metadata } from "next";
import { Suspense } from "react";
import { OnboardingProfileForm } from "@/components/settings/onboarding-profile-form";
import { OnboardingStepHeader, STEP_COPY } from "@/components/settings/onboarding-steps";
import { profileValuesFrom } from "@/components/settings/profile-values";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sender details · Set up" };

export default function OnboardingProfilePage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={2} />}>
      <ProfileStep />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function ProfileStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  return (
    <div className="flex flex-col gap-6">
      <OnboardingStepHeader
        step="profile"
        steps={onboardingSteps(view)}
        title={STEP_COPY.profile.title}
        description="Every reminder ends with a footer built from these. You can change them later in Settings."
      />
      <OnboardingProfileForm initial={profileValuesFrom(view.settings)} domain={view.settings.sendingDomain} />
    </div>
  );
}
