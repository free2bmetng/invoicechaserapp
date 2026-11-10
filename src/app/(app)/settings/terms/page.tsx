import type { Metadata } from "next";
import { LatePaymentTermsCard } from "@/components/settings/late-terms-card";

export const metadata: Metadata = { title: "Terms · Settings" };

// No account data here: the wording is the same for everyone and nothing is saved.
export default function TermsSettingsPage() {
  return <LatePaymentTermsCard />;
}
