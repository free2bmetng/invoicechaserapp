import type { Metadata } from "next";
import { Suspense } from "react";
import { StripeCard, type StripeNotice } from "@/components/settings/stripe-card";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Payments · Settings" };

type SearchParams = Promise<{ stripe?: string | string[]; reason?: string | string[] }>;

export default function PaymentsSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<CardsSkeleton cards={1} />}>
      <PaymentsBody searchParams={searchParams} />
    </Suspense>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The Connect with Stripe return adds ?stripe=connected or ?stripe=error&reason=<why>.
function noticeFor(status: string | undefined, reason: string | undefined): StripeNotice | null {
  if (status === "connected") return { tone: "ok", message: "Stripe is connected. Reminders now include a payment link." };
  if (status !== "error") return null;
  const messages: Record<string, string> = {
    signin: "Your session ended before Stripe finished. Sign in again, then connect Stripe.",
    state: "That connection attempt expired. Try Connect with Stripe again.",
    denied: "Access wasn't approved on Stripe, so nothing changed.",
    already_connected: "That Stripe account is already connected to another Invoice Chaser account.",
    config: "Stripe isn't set up on this installation yet.",
  };
  return { tone: "danger", message: messages[reason ?? ""] ?? "Stripe couldn't finish connecting, so nothing changed. Try again." };
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function PaymentsBody({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  return (
    <StripeCard
      connected={view.stripe.connected}
      accountLabel={view.stripe.accountLabel}
      appUrlConfigured={view.appUrlConfigured}
      oauthConfigured={view.stripeOauthConfigured}
      restrictedKeyMode={view.stripeRestrictedKeyMode}
      notice={noticeFor(first(params.stripe), first(params.reason))}
    />
  );
}
