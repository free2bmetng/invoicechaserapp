// Plain-language labels and tones for Needs you items, and link styles that match the
// Button component. Shared by server and client components, so no directives here.
import type { NeedsYouKind } from "@/lib/engine";
import type { Tone } from "@/components/ui";

export const KIND_BADGE: Record<NeedsYouKind, { label: string; tone: Tone }> = {
  approval: { label: "Awaiting approval", tone: "warn" },
  failed: { label: "Failed to send", tone: "danger" },
  needs_check: { label: "Check delivery", tone: "warn" },
  reply: { label: "Client replied", tone: "info" },
  bounce: { label: "Bounced", tone: "danger" },
  disputed: { label: "Disputed", tone: "neutral" },
  paid_while_disputed: { label: "Paid while disputed", tone: "warn" },
};

// Mirrors Button's primary and secondary variants, for next/link elements.
export const LINK_BUTTON_PRIMARY =
  "lift inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-ink no-underline shadow-card hover:bg-accent-hover";
export const LINK_BUTTON_SECONDARY =
  "lift inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-surface px-4 text-sm font-medium text-ink no-underline shadow-card hover:border-ink-3 hover:bg-surface-2";

// Delivery statuses for the message log. Kept here, not in the query module, so client components
// can import them without pulling in the database client.
export const DELIVERY_STATUSES = ["sent", "delivered", "bounced", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Failed",
};

// The dashboard headline for a client's payment pattern. Negative values mean the client pays
// before the due date. Null means no paid invoice yet.
export function paymentPatternHeadline(avgDaysLate: number | null): string {
  if (avgDaysLate === null) return "–";
  if (avgDaysLate < 0) return "Paid early";
  const days = Math.round(avgDaysLate);
  if (days === 0) return "Typically pays on the due date";
  return `Typically pays ${days} ${days === 1 ? "day" : "days"} late`;
}
