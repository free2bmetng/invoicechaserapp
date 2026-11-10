import { Suspense } from "react";
import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { NewSequenceButton } from "@/components/sequences/sequence-actions";
import { SequenceCards } from "@/components/sequences/sequence-list";
import { TimelineLegend } from "@/components/sequences/sequence-timeline";
import { windowSentence } from "@/components/sequences/state";
import { listSequences } from "@/lib/engine";
import { sendingProfile, sequenceUsage } from "@/lib/queries/sequences";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sequences" };

export default function SequencesPage() {
  return (
    <>
      <PageHeader
        title="Sequences"
        description="When each reminder goes out, in what tone, and which ones wait for you."
        actions={<NewSequenceButton />}
      />
      <div className="mt-6">
        <Suspense fallback={<ListSkeleton rows={3} />}>
          <SequencesSection />
        </Suspense>
      </div>
    </>
  );
}

// Reads the session and the data, so it sits behind the Suspense boundary above.
async function SequencesSection() {
  const userId = await requireUserId();
  const [sequences, usage, profile] = await Promise.all([listSequences(userId), sequenceUsage(userId), sendingProfile(userId)]);
  if (sequences.length === 0) {
    return (
      <EmptyState
        title="No sequences yet"
        body="Every account starts with a default sequence. If it is missing, add a sequence to plan reminders."
        action={<NewSequenceButton />}
      />
    );
  }
  const standard = sequences.filter((s) => s.kind === "standard");
  const plans = sequences.filter((s) => s.kind === "plan");
  return (
    <div className="grid gap-8">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <TimelineLegend />
        <p className="text-small text-ink-3">{windowSentence(profile.windowStart, profile.windowEnd)}</p>
      </div>
      <section aria-labelledby="standard-heading" className="grid gap-3">
        <div>
          <h2 id="standard-heading" className="text-section-title text-ink">Reminder sequences</h2>
          <p className="mt-0.5 text-small text-ink-3">For open invoices. Days count from each invoice&apos;s due date. A client or an invoice can pick its own.</p>
        </div>
        {standard.length === 0 ? (
          <p className="rounded-[var(--radius-lg)] border border-dashed border-line-strong p-5 text-body text-ink-2">There are no reminder sequences. Make one to schedule reminders.</p>
        ) : (
          <SequenceCards sequences={standard} usage={usage} />
        )}
      </section>
      <section aria-labelledby="plan-heading" className="grid gap-3">
        <div>
          <h2 id="plan-heading" className="text-section-title text-ink">Payment plan sequences</h2>
          <p className="mt-0.5 text-small text-ink-3">For each installment of a payment plan. Days count from the installment&apos;s due date. Plans use the default.</p>
        </div>
        {plans.length === 0 ? (
          <p className="rounded-[var(--radius-lg)] border border-dashed border-line-strong p-5 text-body text-ink-2">No payment plan sequence yet. One is created with the default plan.</p>
        ) : (
          <SequenceCards sequences={plans} usage={usage} />
        )}
      </section>
    </div>
  );
}
