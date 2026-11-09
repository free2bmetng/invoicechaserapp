"use server";

// Server actions for Needs you and Next 7 days. A server action is a public endpoint,
// so each one authenticates first with requireUserId, validates its input, and then
// calls the engine, which enforces ownership and the state rules. Every result is a
// plain { ok, message } value for the client to show.
import { revalidatePath } from "next/cache";
import { systemClock } from "@/lib/clock";
import {
  approveMessage,
  cancelMessage,
  editMessage,
  EngineError,
  holdMessage,
  InvalidStateError,
  NotFoundError,
  resolveNeedsCheck,
  resumeClient,
  resumeContact,
  resumeMessage,
  retryFailed,
  ValidationError,
} from "@/lib/engine";
import { acknowledgePaidWhileDisputed } from "@/lib/engine";
import { heldMessageIdsForClient, isUuid, pendingApprovalIdsForInvoice } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";

export type OpsResult = { ok: true; message: string } | { ok: false; message: string };

const BAD_ITEM = "That item could not be found. Refresh the page and try again.";
const SUBJECT_MAX_LENGTH = 300;
const BODY_MAX_LENGTH = 10_000;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function idField(formData: FormData, name: string): string | null {
  const value = text(formData, name).trim();
  return isUuid(value) ? value : null;
}

function failure(message: string): OpsResult {
  return { ok: false, message };
}

// Engine errors carry plain-English messages. Anything else is logged by name only and
// shown as a calm generic message, so no internal detail reaches the page.
function describeError(err: unknown): string {
  if (err instanceof NotFoundError) return "That item was not found. It may already have been handled.";
  if (err instanceof ValidationError) return err.errors.join(" ");
  if (err instanceof InvalidStateError || err instanceof EngineError) return err.message;
  console.error("Ops action failed:", err instanceof Error ? err.name : "unknown error");
  return "Something went wrong. Try again in a moment.";
}

// Runs the engine work, then refreshes the whole app so the Needs you badge, the lists
// and the dashboard all reflect the change.
async function attempt(work: () => Promise<string>): Promise<OpsResult> {
  let message: string;
  try {
    message = await work();
  } catch (err) {
    return failure(describeError(err));
  }
  revalidatePath("/", "layout");
  return { ok: true, message };
}

// Edited text is templated (merge fields), so it is checked here for shape and then by
// the engine for tokens. Returns the reason when the input is unusable.
function readEdit(formData: FormData): { subject: string; body: string } | string {
  const subject = text(formData, "subject").replace(/\r\n?/g, "\n").trim();
  const body = text(formData, "body").replace(/\r\n?/g, "\n").trim();
  if (!subject) return "Add a subject line.";
  if (!body) return "Add the message body.";
  if (subject.includes("\n")) return "The subject must fit on one line.";
  if (subject.length > SUBJECT_MAX_LENGTH) return `The subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`;
  if (body.length > BODY_MAX_LENGTH) return `The message must be ${BODY_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  return { subject, body };
}

// ---- Approval ----------------------------------------------------------------

export async function approveReminder(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await approveMessage(userId, messageId, systemClock);
    return "Approved. It goes out in the next send window.";
  });
}

// Approves every reminder on one invoice that is awaiting approval, one engine call each, so
// every row keeps its own state history. Ownership is checked by pendingApprovalIdsForInvoice;
// reminders on other invoices and rows in any other state are never touched.
export async function approveAllForInvoice(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const invoiceId = idField(formData, "invoiceId");
  if (!invoiceId) return failure(BAD_ITEM);
  return attempt(async () => {
    const ids = await pendingApprovalIdsForInvoice(userId, invoiceId);
    let done = 0;
    try {
      for (const id of ids) {
        await approveMessage(userId, id, systemClock);
        done += 1;
      }
    } catch (err) {
      // Some may already be approved: refresh the app so the page shows what changed.
      if (done > 0) revalidatePath("/", "layout");
      if (done === 0) throw err;
      throw new InvalidStateError(`Approved ${done} of ${ids.length}. ${describeError(err)}`);
    }
    if (ids.length === 0) return "Nothing on this invoice was waiting for approval.";
    return ids.length === 1
      ? "Approved 1 reminder. It goes out in the next send window."
      : `Approved ${ids.length} reminders. Each goes out at its planned time.`;
  });
}

export async function approveWithEdit(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  const edit = readEdit(formData);
  if (typeof edit === "string") return failure(edit);
  return attempt(async () => {
    await editMessage(userId, messageId, edit, systemClock);
    await approveMessage(userId, messageId, systemClock);
    return "Saved and approved. It goes out in the next send window.";
  });
}

// Edit without approval (Next 7 days). A step that needs approval returns to awaiting approval.
export async function saveReminderEdit(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  const edit = readEdit(formData);
  if (typeof edit === "string") return failure(edit);
  return attempt(async () => {
    await editMessage(userId, messageId, edit, systemClock);
    return "Changes saved.";
  });
}

// ---- Single-message controls -------------------------------------------------

export async function holdReminder(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await holdMessage(userId, messageId, systemClock);
    return "On hold. It will not be sent until you resume it.";
  });
}

export async function resumeReminder(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await resumeMessage(userId, messageId, systemClock);
    return "Resumed. If its planned time has passed, it was skipped rather than sent late.";
  });
}

export async function cancelReminder(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await cancelMessage(userId, messageId, systemClock);
    return "Cancelled. It will not be sent.";
  });
}

export async function retryReminder(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await retryFailed(userId, messageId, systemClock);
    return "Queued again. It goes out in the next send window.";
  });
}

// needs_check resolves only to sent (logged as a manual entry) or skipped.
export async function markReminderSent(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await resolveNeedsCheck(userId, messageId, "sent", systemClock);
    return "Recorded as sent. The message log shows it was marked manually.";
  });
}

export async function dismissReminderCheck(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const messageId = idField(formData, "messageId");
  if (!messageId) return failure(BAD_ITEM);
  return attempt(async () => {
    await resolveNeedsCheck(userId, messageId, "skipped", systemClock);
    return "Dismissed. It will not be sent.";
  });
}

// Marks a payment-while-disputed item as reviewed. The engine loads the invoice inside the
// user's scope, so another account's invoice is refused, and it reports whether anything was open.
export async function acknowledgePaidWhileDisputedAction(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const invoiceId = idField(formData, "invoiceId");
  if (!invoiceId) return failure(BAD_ITEM);
  return attempt(async () => {
    const { acknowledged } = await acknowledgePaidWhileDisputed(userId, invoiceId, systemClock);
    return acknowledged
      ? "Marked as reviewed. It will not show here again."
      : "This item was already reviewed.";
  });
}

// ---- Holds that cover a whole address or client ------------------------------

export async function resumeAddress(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const contactId = idField(formData, "contactId");
  if (!contactId) return failure(BAD_ITEM);
  return attempt(async () => {
    await resumeContact({ userId, contactId, clock: systemClock });
    return "Address resumed. Reminders can go to it again.";
  });
}

export async function resumeClientReminders(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const clientId = idField(formData, "clientId");
  if (!clientId) return failure(BAD_ITEM);
  return attempt(async () => {
    await resumeClient({ userId, clientId, clock: systemClock });
    return "Reminders resumed. Any whose planned time has passed were skipped, not sent late.";
  });
}

// Cancels every held reminder for one client, one engine call each, so every row keeps
// its own state history. Ownership is checked by heldMessageIdsForClient.
export async function cancelHeldReminders(formData: FormData): Promise<OpsResult> {
  const userId = await requireUserId();
  const clientId = idField(formData, "clientId");
  if (!clientId) return failure(BAD_ITEM);
  return attempt(async () => {
    const ids = await heldMessageIdsForClient(userId, clientId);
    for (const id of ids) await cancelMessage(userId, id, systemClock);
    return ids.length === 1 ? "Cancelled 1 held reminder." : `Cancelled ${ids.length} held reminders.`;
  });
}
