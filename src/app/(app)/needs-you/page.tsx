import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Kbd } from "@/components/data";
import { OpsFeedback } from "@/components/ops/feedback";
import { NeedsYouWorkspace } from "@/components/ops/needs-you-workspace";
import { QueueSkeleton } from "@/components/ops/skeletons";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/ui";
import { loadNeedsYou } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Needs you" };

type SearchParams = Promise<{ item?: string | string[] }>;

export default function NeedsYouPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Needs you"
        description="Only what is waiting on you, most urgent first. Nothing here is sent until you act."
        actions={
          <p className="hidden items-center gap-1.5 text-small text-ink-3 lg:flex">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd>
            <span className="mr-2">to move</span>
            <Kbd>A</Kbd>
            <span>to approve</span>
          </p>
        }
      />
      <div className="mt-6">
        <Suspense fallback={<QueueSkeleton />}>
          <NeedsYouQueue searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function NeedsYouQueue({ searchParams }: { searchParams: SearchParams }) {
  const userId = await requireUserId();
  const [view, params] = await Promise.all([loadNeedsYou(userId), searchParams]);
  const item = Array.isArray(params.item) ? params.item[0] : params.item;

  return (
    <OpsFeedback>
      {view.total === 0 ? (
        <Card as="div">
          <EmptyState
            title="Nothing needs you"
            body="You are all caught up. Failed sends, reminders that need approval, replies and bounces appear here."
            action={
              <Link href="/next-7-days" className={buttonClass("secondary")}>
                See the next 7 days
              </Link>
            }
          />
        </Card>
      ) : (
        <NeedsYouWorkspace sections={view.sections} initialKey={item ?? null} />
      )}
    </OpsFeedback>
  );
}
