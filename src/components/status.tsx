import type { InvoiceStatus, MessageStatus } from "@/lib/types";
import { Badge, type Tone } from "./ui";

// Plain-language labels. Users read these daily, so they say what happens next, not what the row is.
export const INVOICE_STATUS_META: Record<InvoiceStatus, { label: string; tone: Tone; help: string }> = {
  open: { label: "Open", tone: "info", help: "Reminders are scheduled." },
  paid: { label: "Paid", tone: "ok", help: "Remaining reminders are cancelled." },
  paused: { label: "Paused", tone: "neutral", help: "Nothing is sent until you resume." },
  disputed: { label: "Disputed", tone: "warn", help: "Nothing is sent while this is disputed." },
  payment_plan: { label: "Payment plan", tone: "accent", help: "Reminders follow the plan's dates." },
  written_off: { label: "Written off", tone: "neutral", help: "Closed. Nothing more is sent." },
};

export const MESSAGE_STATUS_META: Record<MessageStatus, { label: string; tone: Tone }> = {
  pending_approval: { label: "Awaiting approval", tone: "warn" },
  scheduled: { label: "Scheduled", tone: "info" },
  held: { label: "On hold", tone: "neutral" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "accent" },
  delivered: { label: "Delivered", tone: "ok" },
  bounced: { label: "Bounced", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  needs_check: { label: "Check delivery", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const meta = INVOICE_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const meta = MESSAGE_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
