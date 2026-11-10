import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { buttonClass, Card, cx } from "@/components/ui";
import { OnboardingStepHeader, STEP_COPY } from "@/components/settings/onboarding-steps";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView, onboardingSteps } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Invoices · Set up" };

export default function OnboardingInvoicesPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={1} />}>
      <InvoicesStep />
    </Suspense>
  );
}

function Choice({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link href={href} className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/70 sm:px-6">
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-ink">{title}</span>
        <span className="block text-small text-ink-3">{detail}</span>
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-ink-3">
        <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function InvoicesStep() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const count = view.invoiceCount;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <OnboardingStepHeader
        step="invoices"
        steps={onboardingSteps(view)}
        title={STEP_COPY.invoices.title}
        description={
          count > 0
            ? `You have ${count} ${count === 1 ? "invoice" : "invoices"}. Add more now or later. This step is optional.`
            : "Optional. Reminders are planned for the invoices you add, now or later."
        }
      />
      <Card className="divide-y divide-line overflow-hidden">
        <Choice href="/invoices/new" title="Add an invoice" detail="Client, amount and due date. Takes a minute." />
        <Choice
          href="/invoices/import"
          title="Import a CSV file"
          detail="Every row is checked before anything is imported."
        />
      </Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Link href="/onboarding/review" className={cx(buttonClass(count > 0 ? "primary" : "secondary"), "max-sm:w-full")}>
          {count > 0 ? "Continue" : "Skip for now"}
        </Link>
        <p className="text-small text-ink-3">Next: review the default reminders.</p>
      </div>
    </div>
  );
}
