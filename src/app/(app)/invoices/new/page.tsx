import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { NewInvoiceForm } from "@/components/invoices/new-invoice-form";
import { addDaysIso, todayIn } from "@/components/invoices/format";
import { FormSkeleton } from "@/components/invoices/skeletons";
import { CURRENCIES } from "@/components/invoices/currencies";
import { isUuidText } from "@/components/invoices/form-state";
import { lastInvoiceCurrency, listClientChoices, listStandardSequenceChoices, loadWorkspace } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "New invoice" };

export default function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <>
      <Link href="/invoices" className="inline-flex text-[14px] font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        ← Back to invoices
      </Link>
      <PageHeader
        title="New invoice"
        description="Add one invoice. Reminders are planned from its due date once the sender profile is complete."
      />
      <div className="mt-8 max-w-3xl">
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
  const [workspace, clients, sequences, lastCurrency] = await Promise.all([
    loadWorkspace(userId),
    listClientChoices(userId),
    listStandardSequenceChoices(userId),
    lastInvoiceCurrency(userId),
  ]);
  const today = todayIn(workspace.zone);
  return (
    <NewInvoiceForm
      clients={clients}
      currencies={CURRENCIES}
      sequences={sequences}
      profileComplete={workspace.profileComplete}
      initialClientId={requested && isUuidText(requested) ? requested : null}
      defaults={{ currency: lastCurrency ?? "USD", issueDate: today, dueDate: addDaysIso(today, 14) }}
    />
  );
}
