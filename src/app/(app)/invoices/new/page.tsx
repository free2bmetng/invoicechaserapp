import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { NewInvoiceForm } from "@/components/invoices/new-invoice-form";
import { BackLink } from "@/components/invoices/back-link";
import { todayIn } from "@/components/invoices/format";
import { FormSkeleton } from "@/components/invoices/skeletons";
import { CURRENCIES } from "@/components/invoices/currencies";
import { isUuidText } from "@/components/invoices/form-state";
import { listSequences } from "@/lib/engine";
import {
  clientInvoiceDefaults, lastInvoiceCurrency, listClientChoices, listStandardSequenceChoices, loadWorkspace,
} from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "New invoice" };

export default function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <>
      <BackLink href="/invoices">Invoices</BackLink>
      <PageHeader title="New invoice" />
      <div className="mt-6 sm:mt-8">
        <Suspense fallback={<FormSkeleton />}>
          <NewInvoiceLoader searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

// Reads the session and the user's data, so it sits behind the Suspense boundary above.
async function NewInvoiceLoader({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const requested = Array.isArray(sp.client) ? sp.client[0] : sp.client;
  const [workspace, clients, sequences, allSequences, clientDefaults, lastCurrency] = await Promise.all([
    loadWorkspace(userId),
    listClientChoices(userId),
    listStandardSequenceChoices(userId),
    listSequences(userId),
    clientInvoiceDefaults(userId),
    lastInvoiceCurrency(userId),
  ]);
  const today = todayIn(workspace.zone);
  const standard = allSequences.filter((s) => s.kind === "standard");
  return (
    <NewInvoiceForm
      clients={clients}
      currencies={CURRENCIES}
      sequences={sequences}
      previewSequences={standard.map((s) => ({
        id: s.id,
        name: s.name,
        steps: s.steps.map((st) => ({ offsetDays: st.offsetDays, tone: st.tone, subject: st.subject, body: st.body, requiresApproval: st.requiresApproval })),
      }))}
      defaultSequenceId={standard.find((s) => s.isDefault)?.id ?? null}
      clientDefaults={clientDefaults}
      today={today}
      sender={{ senderName: workspace.sender.senderName, businessName: workspace.sender.businessName }}
      profileComplete={workspace.profileComplete}
      initialClientId={requested && isUuidText(requested) ? requested : null}
      defaults={{ currency: lastCurrency ?? "USD", issueDate: today }}
    />
  );
}
