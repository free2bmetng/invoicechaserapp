import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { messageLogHref } from "@/components/ops/kinds";
import { MessageFilters } from "@/components/ops/message-filters";
import { MessageLogPager, MessageLogTable, StatusTabs, type LogView } from "@/components/ops/message-log";
import { ListSkeleton } from "@/components/ops/skeletons";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/ui";
import { countMessageLogByStatus, encodeCursor, listClientOptions, listMessageLog, parseMessageLogFilters } from "@/lib/queries/messages";
import { loadSettingsView } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Message log" };

type SearchParams = Promise<{
  status?: string | string[];
  client?: string | string[];
  cursor?: string | string[];
  q?: string | string[];
  id?: string | string[];
}>;

export default function MessageLogPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Message log" description="Every reminder that went out, with the exact text the client received." />
      <div className="mt-6 flex flex-col gap-4">
        <Suspense fallback={<ListSkeleton rows={6} />}>
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
    q: first(raw.q),
    id: first(raw.id),
  });
  const [settings, page, clients, counts] = await Promise.all([
    loadSettingsView(userId),
    listMessageLog(userId, filters),
    listClientOptions(userId),
    countMessageLogByStatus(userId, filters),
  ]);
  const view: LogView = {
    status: filters.status,
    clientId: filters.clientId,
    q: filters.q ?? null,
    cursor: filters.cursor ? encodeCursor(filters.cursor.sentAt, filters.cursor.id) : null,
    selectedId: filters.selectedId ?? null,
  };
  const filtered = filters.status !== null || filters.clientId !== null || Boolean(filters.q);

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <StatusTabs view={view} counts={counts} />
        <MessageFilters status={filters.status} clientId={filters.clientId} q={filters.q ?? null} clients={clients} />
      </div>
      <Card as="div" className="overflow-hidden">
        {page.rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No messages match"
              body="Try another status, client or search. Clear the filters to see every message."
              action={
                <Link href={messageLogHref({})} className={buttonClass("secondary")}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              title="No reminders have gone out yet"
              body="Each reminder that is sent is kept here with its exact text. See what is waiting in Needs you and Next 7 days."
              action={
                <Link href="/needs-you" className={buttonClass("primary")}>
                  Open Needs you
                </Link>
              }
            />
          )
        ) : (
          <MessageLogTable rows={page.rows} timezone={settings.timezone} view={view} />
        )}
      </Card>
      <MessageLogPager nextCursor={page.nextCursor} view={view} shown={page.rows.length} />
    </>
  );
}
