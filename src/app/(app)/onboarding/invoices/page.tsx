import { Suspense } from "react";
import { PageHeader } from "@/components/ui";
import { LinkButton, OnboardingProgress } from "@/components/settings/onboarding-steps";
import { SettingsCard } from "@/components/settings/form-kit";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export default function OnboardingInvoicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Setup · Step 3 of 4"
        title="Add your invoices"
        description="Add invoices one at a time, or import a CSV file. This step is optional, and you can do it later."
      />
      <Suspense fallback={<CardsSkeleton cards={1} />}>
        <InvoicesStep />
      </Suspense>
    </>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function InvoicesStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const count = view.invoiceCount;

  return (
    <div className="mt-8 flex flex-col gap-6">
      <OnboardingProgress steps={onboardingSteps(view)} current="invoices" />
      <div>
        <SettingsCard
          id="invoices-step"
          title="Invoices"
          description={
            <p>
              You have {count} {count === 1 ? "invoice" : "invoices"} so far.
            </p>
          }
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap gap-3">
              <LinkButton href="/invoices/new" primary>
                Add an invoice
              </LinkButton>
              <LinkButton href="/invoices/import">Import a CSV file</LinkButton>
            </div>
            <p className="text-[13.5px] leading-6 text-ink-3">
              A CSV file needs these headers, in any order: client_name, client_email, invoice_number, amount, currency,
              issue_date, due_date. Extra columns are ignored. Every row is checked before anything is imported.
            </p>
            <div className="border-t border-line pt-5">
              <LinkButton href="/onboarding/review">Continue to review</LinkButton>
            </div>
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}
