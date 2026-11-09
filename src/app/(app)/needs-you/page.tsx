import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NeedsYouCard } from "@/components/ops/needs-you-card";
import { OpsFeedback } from "@/components/ops/feedback";
import { QueueSkeleton } from "@/components/ops/skeletons";
import { EmptyState, PageHeader } from "@/components/ui";
import { LINK_BUTTON_SECONDARY } from "@/components/ops/kinds";
import { loadNeedsYou } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Needs you" };

export default function NeedsYouPage() {
  return (
    <>
      <PageHeader
        eyebrow="Action"
        title="Needs you"
        description="Only the things waiting on you. Nothing here is sent until you act on it."
      />
      <div className="mt-8">
        <Suspense fallback={<QueueSkeleton />}>
          <NeedsYouQueue />
        </Suspense>
      </div>
    </>
  );
}

async function NeedsYouQueue() {
  const userId = await requireUserId();
  const view = await loadNeedsYou(userId);

  return (
    <OpsFeedback>
      {view.total === 0 ? (
        <EmptyState
          title="Nothing needs you"
          body="You are all caught up. Reminders that need a decision, failed sends, client replies and bounces will appear here."
          action={
            <Link href="/next-7-days" className={LINK_BUTTON_SECONDARY}>
              See the next 7 days
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-10">
          {view.sections.map((section) => (
            <section key={section.kind} aria-labelledby={`needs-${section.kind}`} className="flex flex-col gap-4">
              <div>
                <h2 id={`needs-${section.kind}`} className="text-[18px] leading-7 font-semibold text-ink">
                  {section.heading}{" "}
                  <span className="num font-medium text-ink-3">({section.rows.length})</span>
                </h2>
                <p className="mt-1 text-[14px] leading-6 text-ink-2">{section.explanation}</p>
              </div>
              {section.rows.map((row) => (
                <NeedsYouCard key={row.key} row={row} />
              ))}
            </section>
          ))}
        </div>
      )}
    </OpsFeedback>
  );
}
