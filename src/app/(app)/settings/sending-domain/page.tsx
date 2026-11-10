import type { Metadata } from "next";
import { Suspense } from "react";
import { saveSendingDomainAction } from "@/app/actions/settings";
import { SendingDomainForm } from "@/components/settings/sending-domain-form";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sending domain · Settings" };

export default function SendingDomainPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={2} />}>
      <SendingDomainBody />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function SendingDomainBody() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  return (
    <SendingDomainForm
      initialDomain={view.settings.sendingDomain}
      action={saveSendingDomainAction}
      sendingEnabled={view.sendingEnabled}
    />
  );
}
