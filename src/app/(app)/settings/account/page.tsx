import type { Metadata } from "next";
import { Suspense } from "react";
import { SummaryList } from "@/components/data";
import { DataCard } from "@/components/settings/data-card";
import { DeleteAccountCard } from "@/components/settings/delete-account-card";
import { Panel } from "@/components/settings/form-kit";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Account · Settings" };

export default function AccountSettingsPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={3} />}>
      <AccountBody />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function AccountBody() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  return (
    <div className="flex flex-col gap-6">
      <Panel id="account-details" title="Account">
        <SummaryList items={[{ label: "Email address", value: view.email }]} />
      </Panel>
      <DataCard />
      <DeleteAccountCard email={view.email} />
    </div>
  );
}
