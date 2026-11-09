import { Suspense } from "react";
import { PageHeader } from "@/components/ui";
import { OnboardingProfileForm } from "@/components/settings/onboarding-profile-form";
import { OnboardingProgress } from "@/components/settings/onboarding-steps";
import { SettingsCard } from "@/components/settings/form-kit";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export default function OnboardingProfilePage() {
  return (
    <>
      <PageHeader
        eyebrow="Setup · Step 1 of 4"
        title="Sender details and settings"
        description="Reminders are built from these details. You can change any of them later in Settings."
      />
      <Suspense fallback={<CardsSkeleton cards={2} />}>
        <ProfileStep />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function ProfileStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const s = view.settings;

  return (
    <div className="mt-8 flex flex-col gap-6">
      <OnboardingProgress steps={onboardingSteps(view)} current="profile" />
      <div>
        <SettingsCard
          id="profile-details"
          title="Your details"
          description={<p>Your sender details come first. The send window, limit and digest have sensible defaults.</p>}
        >
          <OnboardingProfileForm
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
        </SettingsCard>
      </div>
    </div>
  );
}
