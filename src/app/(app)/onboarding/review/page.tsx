import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { confirmSequenceReviewAction } from "@/app/actions/settings";
import { Button, buttonClass, Card, cx } from "@/components/ui";
import { OnboardingStepHeader, SequenceSummary, STEP_COPY } from "@/components/settings/onboarding-steps";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Default reminders · Set up" };

export default function OnboardingReviewPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={2} />}>
      <ReviewStep />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function ReviewStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <OnboardingStepHeader
        step="review"
        steps={onboardingSteps(view)}
        title={STEP_COPY.review.title}
        description="Every new invoice follows these unless you pick another sequence. The first reminder to a new client waits for your approval."
      />
      <Card className="overflow-hidden">
        <SequenceSummary steps={view.steps} />
      </Card>
      <form action={confirmSequenceReviewAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {view.sequenceReviewed ? (
          <>
            <Link href="/onboarding" className={cx(buttonClass("primary"), "max-sm:w-full")}>
              Back to the checklist
            </Link>
            <p className="text-small text-ok">Marked as reviewed.</p>
          </>
        ) : (
          <Button type="submit" variant="primary" className="max-sm:w-full">
            Looks good, continue
          </Button>
        )}
        <Link href="/sequences" className={cx(buttonClass("ghost"), "max-sm:w-full")}>
          Edit reminders
        </Link>
      </form>
    </div>
  );
}
