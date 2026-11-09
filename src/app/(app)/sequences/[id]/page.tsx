import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { SequenceEditor } from "@/components/sequences/sequence-editor";
import { isUuidText } from "@/components/invoices/form-state";
import { listSequences } from "@/lib/engine";
import { previewChoices, sequenceUsage } from "@/lib/queries/sequences";
import { loadWorkspace } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sequence" };

export default function SequenceEditorPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <SequenceEditorSection params={params} />
    </Suspense>
  );
}

async function SequenceEditorSection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidText(id)) notFound();
  const userId = await requireUserId();
  const all = await listSequences(userId);
  const found = all.find((s) => s.id === id);
  if (!found) notFound();

  const [choices, usage, workspace] = await Promise.all([
    previewChoices(userId, found.kind),
    sequenceUsage(userId),
    loadWorkspace(userId),
  ]);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-ink-3">
        <Link href="/sequences" className="hover:text-ink">Sequences</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{found.name}</span>
      </nav>
      <PageHeader
        title={found.name}
        description={found.kind === "plan" ? "Reminders for each installment of a payment plan." : "Reminders for open invoices, in order of their offset from the due date."}
      />
      <div className="mt-8">
        <SequenceEditor
          sequence={{
            id: found.id,
            name: found.name,
            kind: found.kind,
            isDefault: found.isDefault,
            steps: found.steps.map((s) => ({
              id: s.id,
              offsetDays: s.offsetDays,
              tone: s.tone as "friendly" | "neutral" | "firm" | "custom",
              subject: s.subject,
              body: s.body,
              requiresApproval: s.requiresApproval,
              isFinalNotice: s.isFinalNotice,
            })),
          }}
          choices={choices}
          usage={usage.get(found.id) ?? 0}
          stripeConnected={workspace.stripeConnected}
        />
      </div>
    </>
  );
}
