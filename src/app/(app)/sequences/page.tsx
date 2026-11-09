import { Suspense } from "react";
import type { Metadata } from "next";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/invoices/skeletons";
import { NewSequenceButton } from "@/components/sequences/sequence-actions";
import { SequenceCards } from "@/components/sequences/sequence-list";
import { listSequences } from "@/lib/engine";
import { sequenceUsage } from "@/lib/queries/sequences";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sequences" };

export default function SequencesPage() {
  return (
    <>
      <PageHeader
        title="Sequences"
        description="When each reminder goes out, and how many invoices use each sequence."
        actions={<NewSequenceButton />}
      />
      <div className="mt-8">
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
  const [sequences, usage] = await Promise.all([listSequences(userId), sequenceUsage(userId)]);
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
      <section aria-labelledby="standard-heading" className="grid gap-4">
        <div>
          <h2 id="standard-heading" className="text-[16px] font-semibold text-ink">Reminder sequences</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-3">Used for open invoices. An invoice or client can choose its own.</p>
        </div>
        {standard.length === 0 ? (
          <Card as="section" className="p-5 text-[14px] text-ink-2">There are no reminder sequences. Make one to schedule reminders.</Card>
        ) : (
          <SequenceCards sequences={standard} usage={usage} />
        )}
      </section>
      <section aria-labelledby="plan-heading" className="grid gap-4">
        <div>
          <h2 id="plan-heading" className="text-[16px] font-semibold text-ink">Payment plan sequences</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-3">Used for each installment of a payment plan. Offsets are relative to each installment&apos;s due date.</p>
        </div>
        {plans.length === 0 ? (
          <Card as="section" className="p-5 text-[14px] text-ink-2">No payment plan sequence yet. One is created with the default plan.</Card>
        ) : (
          <SequenceCards sequences={plans} usage={usage} />
        )}
      </section>
    </div>
  );
}
