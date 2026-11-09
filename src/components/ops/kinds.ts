// Plain-language labels and tones for Needs you items, and link styles that match the
// Button component. Shared by server and client components, so no directives here.
import type { NeedsYouKind } from "@/lib/engine";
import type { NeedsYouRow } from "@/lib/queries/ops";
import { buttonClass, type Tone } from "@/components/ui";

export const KIND_BADGE: Record<NeedsYouKind, { label: string; tone: Tone }> = {
  approval: { label: "Awaiting approval", tone: "warn" },
  failed: { label: "Failed to send", tone: "danger" },
  needs_check: { label: "Check delivery", tone: "warn" },
  reply: { label: "Client replied", tone: "accent" },
  bounce: { label: "Bounced", tone: "danger" },
  disputed: { label: "Disputed", tone: "warn" },
  paid_while_disputed: { label: "Paid while disputed", tone: "warn" },
};

// Link styles that match Button, for next/link elements.
export const LINK_BUTTON_PRIMARY = buttonClass("primary");
export const LINK_BUTTON_SECONDARY = buttonClass("secondary");

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

// Fixed once the contact's address differs from the one that bounced. Without a record of the
// bounced address, resume is offered rather than blocking the user.
export function bounceFixed(row: NeedsYouRow): boolean {
  return row.bounce !== null && (row.bounce.bouncedEmail === null || row.bounce.currentEmail !== row.bounce.bouncedEmail);
}

// Whether a Needs you row carries an inline action. Delivery checks and disputes need a closer
// look, so selecting the row shows their options instead.
export function hasQuickAction(row: NeedsYouRow): boolean {
  return row.kind !== "needs_check" && row.kind !== "disputed";
}

// The URL of a message log view. Empty values are left out. Shared by the server page and the
// client filter controls, so it lives here rather than beside the query.
export function messageLogHref(values: {
  status?: string | null;
  client?: string | null;
  q?: string | null;
  cursor?: string | null;
  id?: string | null;
}): string {
  const params = new URLSearchParams();
  if (values.status) params.set("status", values.status);
  if (values.client) params.set("client", values.client);
  if (values.q) params.set("q", values.q);
  if (values.cursor) params.set("cursor", values.cursor);
  if (values.id) params.set("id", values.id);
  const query = params.toString();
  return query ? `/messages?${query}` : "/messages";
}
