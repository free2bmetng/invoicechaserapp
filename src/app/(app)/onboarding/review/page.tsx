import Link from "next/link";
import { Suspense } from "react";
import { confirmSequenceReviewAction } from "@/app/actions/settings";
import { Button, PageHeader } from "@/components/ui";
import { SettingsCard } from "@/components/settings/form-kit";
import { LinkButton, OnboardingProgress, SequenceSummary } from "@/components/settings/onboarding-steps";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export default function OnboardingReviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Setup · Step 4 of 4"
        title="Review the default reminders"
        description="Every new invoice gets these reminders unless you choose a different sequence."
      />
      <Suspense fallback={<CardsSkeleton cards={2} />}>
        <ReviewStep />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function ReviewStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <OnboardingProgress steps={onboardingSteps(view)} current="review" />
      <div>
        <SettingsCard
          id="default-sequence"
          title="Default reminders"
          description={
            <p>
              Check the timing and the wording. The first reminder to each new client waits for your approval unless
              auto-send is on for that client.
            </p>
          }
        >
          <div className="flex flex-col gap-6">
            <SequenceSummary steps={view.steps} />
            <div className="flex flex-wrap gap-3">
              <LinkButton href="/sequences">Edit reminders</LinkButton>
            </div>

            <form
              action={confirmSequenceReviewAction}
              className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-[13.5px] leading-6 text-ink-2">
                {view.sequenceReviewed
                  ? "You have marked these reminders as reviewed. You can change them at any time."
                  : "Mark them as reviewed to complete this step."}
              </p>
              <Button type="submit" variant="primary" className="w-full sm:w-auto">
                I have reviewed these reminders
              </Button>
            </form>
          </div>
        </SettingsCard>
      </div>
      <p className="text-[13.5px] leading-6 text-ink-3">
        <Link className="underline underline-offset-4 hover:text-ink" href="/onboarding">
          Back to setup
        </Link>
      </p>
    </div>
  );
}
