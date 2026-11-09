"use client";

// One Needs you item: the compact action that sits on its queue row, and the detail shown
// beside the queue (desktop) or under the row (phone) when the item is selected.
import Link from "next/link";
import { useState } from "react";
import {
  acknowledgePaidWhileDisputedAction,
  approveAllForInvoice,
  approveReminder,
  approveWithEdit,
  cancelHeldReminders,
  cancelReminder,
  dismissReminderCheck,
  holdReminder,
  markReminderSent,
  resumeAddress,
  resumeClientReminders,
  retryReminder,
} from "@/app/actions/ops";
import { MoneyList } from "@/components/money";
import { Button, buttonClass, cx } from "@/components/ui";
import type { NeedsYouRow } from "@/lib/queries/ops";
import { ActionError, useOpsAction } from "./feedback";
import { ConfirmInline } from "./confirm-inline";
import { bounceFixed, KIND_BADGE } from "./kinds";
import { ReminderEditor } from "./reminder-editor";
import { MessageText, PAY_LINK_NOTICE, RecordedAttempt } from "./reminder-view";
import { PAY_LINK_PLACEHOLDER } from "@/lib/templates";

// The one action a row carries inline. Items that need a closer look (delivery checks,
// disputes) carry none: selecting the row shows their options.
export function RowQuickAction({ row }: { row: NeedsYouRow }) {
  const { pending, run } = useOpsAction({ banner: true });
  const who = row.clientName ?? "this item";
  if (row.kind === "approval" && row.messageId) {
    const messageId = row.messageId;
    return (
      <Button size="sm" disabled={pending} aria-label={`Approve ${row.invoiceNumber ?? "reminder"} for ${who}`} onClick={() => void run(approveReminder, { messageId })}>
        {pending ? "Approving…" : "Approve"}
      </Button>
    );
  }
  if (row.kind === "failed" && row.messageId) {
    const messageId = row.messageId;
    return (
      <Button size="sm" disabled={pending} aria-label={`Retry ${row.invoiceNumber ?? "reminder"} for ${who}`} onClick={() => void run(retryReminder, { messageId })}>
        {pending ? "Retrying…" : "Retry"}
      </Button>
    );
  }
  if (row.kind === "reply" && row.clientId) {
    const clientId = row.clientId;
    return (
      <Button size="sm" disabled={pending} aria-label={`Resume reminders for ${who}`} onClick={() => void run(resumeClientReminders, { clientId })}>
        {pending ? "Resuming…" : "Resume"}
      </Button>
    );
  }
  if (row.kind === "bounce" && row.contactId && row.clientId) {
    const contactId = row.contactId;
    return bounceFixed(row) ? (
      <Button size="sm" disabled={pending} aria-label={`Resume the address for ${who}`} onClick={() => void run(resumeAddress, { contactId })}>
        Resume
      </Button>
    ) : (
      <Link href={`/clients/${row.clientId}`} className={buttonClass("secondary", "sm")} aria-label={`Fix the address for ${who}`}>
        Fix address
      </Link>
    );
  }
  if (row.kind === "paid_while_disputed" && row.invoiceId) {
    const invoiceId = row.invoiceId;
    return (
      <Button size="sm" disabled={pending} aria-label={`Mark ${row.invoiceNumber ?? "invoice"} as reviewed`} onClick={() => void run(acknowledgePaidWhileDisputedAction, { invoiceId })}>
        Mark reviewed
      </Button>
    );
  }
  return null;
}

// "Approve all 3 for HC-3001". Shown once, above that invoice's run of approvals.
export function ApproveAllButton({ invoiceId, invoiceNumber, count }: { invoiceId: string; invoiceNumber: string; count: number }) {
  const { pending, run } = useOpsAction({ banner: true });
  return (
    <Button size="sm" variant="secondary" disabled={pending} onClick={() => void run(approveAllForInvoice, { invoiceId })}>
      {pending ? "Approving…" : `Approve all ${count} for ${invoiceNumber}`}
    </Button>
  );
}

// The message framed like an email: who it goes to, the subject, then the body.
function EmailFrame({ to, subject, text, caption }: { to: string | null; subject: string; text: string; caption: string }) {
  const hasLink = text.includes(PAY_LINK_PLACEHOLDER);
  return (
    <figure className="overflow-hidden rounded-[12px] border border-line bg-surface">
      <figcaption className="sr-only">{caption}</figcaption>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-3 text-small">
        {to ? (
          <>
            <dt className="text-ink-3">To</dt>
            <dd className="min-w-0 truncate text-ink-2">{to}</dd>
          </>
        ) : null}
        <dt className="text-ink-3">Subject</dt>
        <dd className="min-w-0 font-medium break-words text-ink">{subject}</dd>
      </dl>
      <div className="max-h-[26rem] overflow-y-auto px-4 py-4">
        <MessageText text={hasLink ? text.split(PAY_LINK_PLACEHOLDER).join("[payment link]") : text} />
        {hasLink ? <p className="mt-3 text-small text-ink-3">{PAY_LINK_NOTICE}</p> : null}
      </div>
    </figure>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}

export function NeedsYouDetail({ row, inline = false }: { row: NeedsYouRow; inline?: boolean }) {
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useOpsAction();
  const reminder = row.reminder;
  const messageId = row.messageId ?? "";
  const kind = KIND_BADGE[row.kind];
  const headingId = `detail-${row.key.replace(/[^a-z0-9]/gi, "")}${inline ? "-inline" : ""}`;

  const cancel = (
    <ConfirmInline
      trigger="Cancel"
      question="Cancel this reminder?"
      consequence="It will not be sent. This cannot be undone."
      confirmLabel="Cancel reminder"
      pending={pending}
      onConfirm={() => void run(cancelReminder, { messageId })}
    />
  );

  let actions: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (row.kind === "approval" && reminder) {
    actions = editing ? null : (
      <>
        <Button variant="primary" disabled={pending} onClick={() => void run(approveReminder, { messageId })}>
          Approve
        </Button>
        <Button disabled={pending} onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => void run(holdReminder, { messageId })}>
          Hold
        </Button>
        {cancel}
      </>
    );
    body = editing ? (
      <ReminderEditor
        messageId={messageId}
        subject={reminder.subject}
        body={reminder.body}
        submitLabel="Save and approve"
        action={approveWithEdit}
        note="Your edits apply to this one reminder only."
        onCancel={() => setEditing(false)}
        onDone={() => setEditing(false)}
      />
    ) : reminder.preview ? (
      <EmailFrame to={reminder.contactEmail} subject={reminder.preview.subject} text={reminder.preview.text} caption="The message as the client will read it" />
    ) : (
      <p className="rounded-[12px] border border-warn/25 bg-warn-soft px-4 py-3 text-small text-warn">
        {reminder.previewNote ?? "This message cannot be shown yet."}
      </p>
    );
  } else if (row.kind === "failed" && reminder) {
    actions = (
      <>
        <Button variant="primary" disabled={pending} onClick={() => void run(retryReminder, { messageId })}>
          Retry sending
        </Button>
        {cancel}
      </>
    );
    body = reminder.preview ? (
      <EmailFrame to={reminder.contactEmail} subject={reminder.preview.subject} text={reminder.preview.text} caption="The message that did not send" />
    ) : null;
  } else if (row.kind === "needs_check" && reminder) {
    actions = (
      <>
        <Button variant="primary" disabled={pending} onClick={() => void run(markReminderSent, { messageId })}>
          Mark as sent
        </Button>
        <ConfirmInline
          trigger="Dismiss"
          question="Dismiss this reminder without sending it?"
          consequence="It will be marked skipped and will never be sent."
          confirmLabel="Dismiss reminder"
          pending={pending}
          onConfirm={() => void run(dismissReminderCheck, { messageId })}
        />
      </>
    );
    body = (
      <>
        <p className="text-small text-ink-2">
          Mark it as sent only if the client received it or you sent it yourself. Dismiss it if it did not go out and should not.
        </p>
        <RecordedAttempt reminder={reminder} />
      </>
    );
  } else if (row.kind === "reply" && row.clientId) {
    const clientId = row.clientId;
    actions = (
      <>
        <Button variant="primary" disabled={pending} onClick={() => void run(resumeClientReminders, { clientId })}>
          Resume reminders
        </Button>
        <ConfirmInline
          trigger="Cancel held reminders"
          question="Cancel the held reminders for this client?"
          consequence="None of them will be sent. This cannot be undone."
          confirmLabel="Cancel held reminders"
          pending={pending}
          onConfirm={() => void run(cancelHeldReminders, { clientId })}
        />
      </>
    );
    body = (
      <p className="text-small text-ink-2">
        Read their reply, then resume the reminders or cancel them. Any whose planned time has passed are skipped, not sent late.
      </p>
    );
  } else if (row.kind === "bounce" && row.contactId) {
    const contactId = row.contactId;
    const fixed = bounceFixed(row);
    actions = fixed ? (
      <Button variant="primary" disabled={pending} onClick={() => void run(resumeAddress, { contactId })}>
        Resume this address
      </Button>
    ) : (
      <Link href={`/clients/${row.clientId ?? ""}`} className={buttonClass("primary")}>
        Fix the address
      </Link>
    );
    body = (
      <p className="text-small text-ink-2">
        {fixed && row.bounce ? (
          <>
            The address is now <span className="font-medium break-all text-ink">{row.bounce.currentEmail}</span>. Resume to send reminders to it again.
          </>
        ) : (
          "Nothing more goes to this address until you change it on the client page and resume it."
        )}
      </p>
    );
  } else if (row.kind === "paid_while_disputed" && row.invoiceId) {
    const invoiceId = row.invoiceId;
    actions = (
      <Button variant="primary" disabled={pending} onClick={() => void run(acknowledgePaidWhileDisputedAction, { invoiceId })}>
        Mark as reviewed
      </Button>
    );
    body = <p className="text-small text-ink-2">{row.detail}</p>;
  } else if (row.kind === "disputed") {
    body = (
      <p className="text-small text-ink-2">
        Reminders stay stopped until you change the invoice status. They resume when it moves back to open or payment plan.
      </p>
    );
    actions = row.invoiceId ? (
      <Link href={`/invoices/${row.invoiceId}`} className={buttonClass("secondary")}>
        Open the invoice
      </Link>
    ) : null;
  }

  return (
    <section aria-labelledby={headingId} className={cx("flex flex-col gap-4", inline ? "px-4 pt-1 pb-5 sm:px-5" : "p-5")}>
      {inline ? null : (
        <header className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-small font-medium text-ink-2">
            <span aria-hidden="true" className={cx("size-1.5 rounded-full", DOT[kind.tone])} />
            {kind.label}
          </p>
          <h2 id={headingId} className="text-section-title text-ink">
            {row.clientId ? (
              <Link href={`/clients/${row.clientId}`} className="underline-offset-4 hover:underline">
                {row.clientName ?? row.title}
              </Link>
            ) : (
              (row.clientName ?? row.title)
            )}
          </h2>
        </header>
      )}
      {inline ? (
        <h3 id={headingId} className="sr-only">
          {row.clientName ?? row.title}
        </h3>
      ) : null}

      <dl className="flex flex-col gap-1 text-small">
        {row.invoiceNumber ? (
          <Fact label="Invoice">
            {row.invoiceId ? (
              <Link href={`/invoices/${row.invoiceId}`} className="font-medium text-accent underline-offset-4 hover:underline">
                {row.invoiceNumber}
              </Link>
            ) : (
              row.invoiceNumber
            )}
          </Fact>
        ) : null}
        {row.atStake.length > 0 ? (
          <Fact label={row.kind === "reply" || row.kind === "bounce" ? "Owed" : "Amount"}>
            <MoneyList amounts={row.atStake} className="justify-start font-medium text-ink" />
          </Fact>
        ) : null}
        {reminder ? <Fact label="Step">{reminder.stepLabel}</Fact> : null}
        {row.plannedLabel ? <Fact label="Planned">{row.plannedLabel}</Fact> : null}
        {row.kind === "bounce" && row.bounce?.bouncedEmail ? <Fact label="Bounced">{row.bounce.bouncedEmail}</Fact> : null}
        {row.kind === "reply" ? <Fact label="On hold">{row.heldCount === 1 ? "1 reminder" : `${row.heldCount} reminders`}</Fact> : null}
      </dl>

      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      <ActionError message={error} />
      {body}
    </section>
  );
}

const DOT: Record<string, string> = {
  neutral: "bg-neutral-fill",
  accent: "bg-accent",
  warn: "bg-warn-fill",
  danger: "bg-danger-fill",
  ok: "bg-ok-fill",
  info: "bg-info-fill",
};
