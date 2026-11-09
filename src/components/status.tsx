import type { InvoiceStatus, MessageStatus } from "@/lib/types";
import { Badge, type Tone } from "./ui";

// Tone rules (DESIGN_V2): ok (green) = success, warn = needs attention, danger = failed,
// info = neutral information only, neutral = waiting or closed. Scheduled is neutral.
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
  scheduled: { label: "Scheduled", tone: "neutral" },
  held: { label: "On hold", tone: "neutral" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "ok" },
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

// Sent and Delivered are two shades of success: Sent is the soft green badge;
// Delivered adds a check, since it is the stronger, confirmed state.
export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const meta = MESSAGE_STATUS_META[status];
  return (
    <Badge tone={meta.tone}>
      {status === "delivered" ? (
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" className="-ml-0.5">
          <path d="M2.5 6.3 4.9 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {meta.label}
    </Badge>
  );
}
