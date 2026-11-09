import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MessageLogList, MessageLogPager } from "@/components/ops/message-log";
import { MessageFilters } from "@/components/ops/message-filters";
import { LINK_BUTTON_PRIMARY } from "@/components/ops/kinds";
import { QueueSkeleton } from "@/components/ops/skeletons";
import { EmptyState, PageHeader } from "@/components/ui";
import {
  listClientOptions,
  listMessageLog,
  parseMessageLogFilters,
} from "@/lib/queries/messages";
import { loadSettingsView } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Message log" };

type SearchParams = Promise<{
  status?: string | string[];
  client?: string | string[];
  cursor?: string | string[];
}>;

export default function MessageLogPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        eyebrow="Record"
        title="Message log"
        description="Every reminder that was sent, with the exact text. Newest first."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Suspense fallback={<QueueSkeleton rows={2} />}>
          <MessageLogContent searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function MessageLogContent({ searchParams }: { searchParams: SearchParams }) {
  const userId = await requireUserId();
  const raw = await searchParams;
  const filters = parseMessageLogFilters({
    status: first(raw.status),
    client: first(raw.client),
    cursor: first(raw.cursor),
  });
  const [settings, page, clients] = await Promise.all([
    loadSettingsView(userId),
    listMessageLog(userId, filters),
    listClientOptions(userId),
  ]);
  const filtered = filters.status !== null || filters.clientId !== null;

  return (
    <>
      <MessageFilters status={filters.status} clientId={filters.clientId} clients={clients} />
      {page.rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No messages match these filters"
            body="Try another delivery status or client. Use Clear filters above to see everything."
          />
        ) : (
          <EmptyState
            title="No reminders have gone out yet"
            body="Each reminder that is sent is kept here with its exact text. See what is waiting in Needs you and Next 7 days."
            action={
              <Link href="/needs-you" className={LINK_BUTTON_PRIMARY}>
                Open Needs you
              </Link>
            }
          />
        )
      ) : (
        <MessageLogList rows={page.rows} timezone={settings.timezone} />
      )}
      <MessageLogPager nextCursor={page.nextCursor} status={filters.status} clientId={filters.clientId} />
    </>
  );
}
