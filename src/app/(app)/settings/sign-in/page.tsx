import type { Metadata } from "next";
import { DateTime } from "luxon";
import { Suspense } from "react";
import { removePasskeyAction } from "@/app/actions/settings";
import { SignInCard, type PasskeyRowView } from "@/components/settings/sign-in-card";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { listPasskeys } from "@/lib/passkeys";
import { getSettingsView } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Sign-in · Settings" };

export default function SignInSettingsPage() {
  return (
    <Suspense fallback={<CardsSkeleton cards={2} />}>
      <SignInBody />
    </Suspense>
  );
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function SignInBody() {
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  // Formatted here, in the account's timezone, so the server and the browser show the same dates.
  const passkeys: PasskeyRowView[] = (await listPasskeys(userId)).map((passkey) => ({
    id: passkey.id,
    label: passkey.label,
    lastUsedLabel: passkey.lastUsedAt
      ? `Last used ${DateTime.fromJSDate(passkey.lastUsedAt, { zone: view.settings.timezone }).toFormat("d LLL yyyy")}`
      : "Not used yet",
  }));
  return <SignInCard passkeys={passkeys} removeAction={removePasskeyAction} email={view.email} />;
}
