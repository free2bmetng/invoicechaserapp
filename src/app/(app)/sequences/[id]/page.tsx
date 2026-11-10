import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge, Card, PageHeader } from "@/components/ui";
import { Table, TBody, THead, Td, Th, Tr } from "@/components/data";
import { Money } from "@/components/money";
import { BackLink } from "@/components/invoices/back-link";
import { DetailSkeleton } from "@/components/invoices/skeletons";
import { dueDateLabel } from "@/components/invoices/format";
import { isUuidText } from "@/components/invoices/form-state";
import { SequenceEditor } from "@/components/sequences/sequence-editor";
import { DuplicateButton, MakeDefaultButton } from "@/components/sequences/sequence-actions";
import { usageText } from "@/components/sequences/sequence-list";
import { windowSentence } from "@/components/sequences/state";
import { listSequences } from "@/lib/engine";
import { previewChoices, sendingProfile, sequenceUsers } from "@/lib/queries/sequences";
import { loadWorkspace } from "@/lib/queries/invoices";
import { getUserId, requireUserId } from "@/lib/session";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!isUuidText(id)) return { title: "Sequence not found" };
  const userId = await getUserId();
  if (!userId) return { title: "Sequence" };
  const found = (await listSequences(userId)).find((s) => s.id === id);
  return { title: found ? found.name : "Sequence not found" };
}

export default function SequenceEditorPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <BackLink href="/sequences">Sequences</BackLink>
      <Suspense fallback={<DetailSkeleton />}>
        <SequenceEditorSection params={params} />
      </Suspense>
    </>
  );
}

async function SequenceEditorSection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidText(id)) notFound();
  const userId = await requireUserId();
  const all = await listSequences(userId);
  const found = all.find((s) => s.id === id);
  if (!found) notFound();

  const [choices, users, workspace, profile] = await Promise.all([
    previewChoices(userId, found.kind),
    sequenceUsers(userId),
    loadWorkspace(userId),
    sendingProfile(userId),
  ]);
  const used = users.get(found.id) ?? [];

  return (
    <>
      <PageHeader
        title={found.name}
        description={
          found.kind === "plan"
            ? "Reminders for each installment of a payment plan, counted from the installment's due date."
            : "Reminders for open invoices, counted from each invoice's due date."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {found.isDefault ? <Badge tone="accent">Default</Badge> : <MakeDefaultButton sequenceId={found.id} name={found.name} />}
            <DuplicateButton sequenceId={found.id} name={found.name} variant="secondary" />
          </div>
        }
      />
      <div className="mt-6">
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
          stripeConnected={workspace.stripeConnected}
          fromAddress={profile.fromAddress}
          windowText={windowSentence(profile.windowStart, profile.windowEnd)}
        />
      </div>

      <section id="used-by" aria-labelledby="used-by-heading" className="mt-8 grid scroll-mt-6 gap-3">
        <div>
          <h2 id="used-by-heading" className="text-section-title text-ink">
            Used by <span className="num ml-1 text-body font-normal text-ink-3">{used.length}</span>
          </h2>
          <p className="mt-0.5 text-small text-ink-3">{usageText(used.length, found.kind, found.isDefault)}. Saving re-plans their unsent reminders.</p>
        </div>
        {used.length > 0 ? (
          <Card className="overflow-hidden">
            <Table label="Open invoices that use this sequence">
              <THead>
                <Th>Invoice</Th>
                <Th>Client</Th>
                <Th>Due</Th>
                <Th align="right">Amount</Th>
              </THead>
              <TBody>
                {used.map((u) => (
                  <Tr key={u.invoiceId} href={`/invoices/${u.invoiceId}`}>
                    <Td primary>{u.invoiceNumber}</Td>
                    <Td label="Client">{u.clientName}</Td>
                    <Td label="Due"><span className="num whitespace-nowrap">{dueDateLabel(u.dueDate)}</span></Td>
                    <Td numeric primary><Money minor={u.amountMinor} currency={u.currency} /></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Card>
        ) : null}
      </section>
    </>
  );
}
