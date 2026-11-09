// User actions on single messages (spec 3.2, 3.3, 3.6). Each one runs under the
// user's lock and the RLS role.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { validateTemplate } from "@/lib/templates";
import { recordDispatchTx } from "./dispatch";
import { InvalidStateError, NotFoundError, ValidationError } from "./errors";
import * as S from "./store";
import { decodePrior, encodePrior, logEvent, resolveUnsent } from "./store";

const UNSENT = ["pending_approval", "scheduled", "held"] as const;

export async function approveMessage(userId: string, messageId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (m.status !== "pending_approval") throw new InvalidStateError("Only a message awaiting approval can be approved.");
    const parties = await S.partiesFor(c, userId, m);
    if (S.holdOn(parties.client, parties.contact)) {
      throw new InvalidStateError("This client or contact is on hold. Resume it before approving the message.");
    }
    // Approval never moves a planned time. A due message goes at the next window.
    await S.updateMessage(c, userId, m.id, { status: "scheduled", prior_status: null }, at);
    await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_approved", detail: { scheduled_message_id: m.id }, at });
  });
}

export async function editMessage(
  userId: string,
  messageId: string,
  input: { subject?: string; body?: string },
  clock: Clock,
): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (!(UNSENT as readonly string[]).includes(m.status)) {
      throw new InvalidStateError("Only an unsent message can be edited.");
    }
    if (!m.step_id) throw new InvalidStateError("This message's step was removed.");
    const step = await S.loadStep(c, userId, m.step_id);
    if (!step) throw new InvalidStateError("This message's step was removed.");

    const subjectOverride = input.subject ?? m.subject_override;
    const bodyOverride = input.body ?? m.body_override;
    const check = validateTemplate({
      subject: subjectOverride ?? step.subject,
      body: bodyOverride ?? step.body,
    });
    if (!check.ok) throw new ValidationError(check.errors);

    const patch: S.MessagePatch = { subject_override: subjectOverride, body_override: bodyOverride };
    // A step that requires approval sends the edited message back for approval.
    if (step.requires_approval) {
      patch.requires_approval = true;
      if (m.status === "scheduled" || m.status === "pending_approval") {
        patch.status = "pending_approval";
      } else if (m.status === "held") {
        const prior = decodePrior(m.prior_status);
        if (prior.base === "scheduled") {
          patch.prior_status = encodePrior({ base: "pending_approval", userHold: prior.userHold });
        }
      }
    }
    await S.updateMessage(c, userId, m.id, patch, at);
    await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_edited", detail: { scheduled_message_id: m.id, approval_reset: patch.status === "pending_approval" }, at });
  });
}

export async function holdMessage(userId: string, messageId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (m.status === "pending_approval" || m.status === "scheduled") {
      const base = m.status === "pending_approval" ? "pending_approval" : "scheduled";
      await S.updateMessage(c, userId, m.id, { status: "held", prior_status: encodePrior({ base, userHold: true }) }, at);
    } else if (m.status === "held") {
      const prior = decodePrior(m.prior_status);
      if (prior.userHold) return;
      await S.updateMessage(c, userId, m.id, { prior_status: encodePrior({ base: prior.base, userHold: true }) }, at);
    } else {
      throw new InvalidStateError("Only an unsent message can be held.");
    }
    await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_held", detail: { scheduled_message_id: m.id, reason: "user" }, at });
  });
}

export async function resumeMessage(userId: string, messageId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (m.status !== "held") throw new InvalidStateError("Only a held message can be resumed.");
    const parties = await S.partiesFor(c, userId, m);
    if (S.holdOn(parties.client, parties.contact)) {
      throw new ValidationError("This client or contact is on hold. Resume the client or contact first.");
    }
    if (m.planned_at.getTime() <= at.getTime()) {
      await S.skipRow(c, userId, m, "planned_time_passed", at);
      return;
    }
    const ruleB = await S.ruleBApplies(c, userId, parties.client);
    const next = resolveUnsent({ base: decodePrior(m.prior_status).base, userHold: false }, m.requires_approval, ruleB, false);
    await S.updateMessage(c, userId, m.id, { status: next.status, prior_status: next.prior }, at);
    await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_resumed", detail: { scheduled_message_id: m.id, status: next.status }, at });
  });
}

export async function cancelMessage(userId: string, messageId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    const cancellable = [...UNSENT, "failed", "cancelled"] as const;
    if (!(cancellable as readonly string[]).includes(m.status)) {
      throw new InvalidStateError("This message was sent or is being sent, so it cannot be cancelled.");
    }
    await S.skipRow(c, userId, m, "cancelled_by_user", at);
  });
}

export async function retryFailed(userId: string, messageId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (m.status !== "failed") throw new InvalidStateError("Only a failed message can be retried.");
    await S.updateMessage(c, userId, m.id, { status: "scheduled", claimed_at: null }, at);
    await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_retried", detail: { scheduled_message_id: m.id }, at });
  });
}

// needs_check resolves only to sent (Mark as sent, logged with manual = true) or skipped (Dismiss).
export async function resolveNeedsCheck(
  userId: string,
  messageId: string,
  outcome: "sent" | "skipped",
  clock: Clock,
): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const m = await S.requireMessage(c, userId, messageId);
    if (m.status !== "needs_check") throw new InvalidStateError("Only a message to check can be resolved.");

    if (outcome === "skipped") {
      await S.skipRow(c, userId, m, "dismissed_after_check", at);
      return;
    }
    const invoice = await S.loadInvoice(c, userId, m.invoice_id);
    const settings = await S.loadSettings(c, userId);
    const contact = m.contact_id ? await S.loadContact(c, userId, m.contact_id) : null;
    if (!contact) throw new NotFoundError("Contact");
    // The snapshot from the send attempt, if one was recorded. Otherwise the raw template.
    const attempt = await c.query<{ detail: Record<string, unknown> }>(
      `select detail from events where user_id = $1 and type = 'send_attempt'
         and detail->>'scheduled_message_id' = $2 order by id desc limit 1`,
      [userId, m.id],
    );
    const snap = attempt.rows[0]?.detail;
    let subject: string;
    let bodyText: string;
    let cc: string[];
    if (snap && typeof snap.body_snapshot === "string") {
      subject = String(snap.subject);
      bodyText = String(snap.body_snapshot);
      cc = Array.isArray(snap.cc) ? (snap.cc as string[]) : [];
    } else {
      const step = m.step_id ? await S.loadStep(c, userId, m.step_id) : null;
      subject = m.subject_override ?? step?.subject ?? invoice.invoice_number;
      bodyText = m.body_override ?? step?.body ?? "";
      cc = await S.ccEmailsFor(c, userId, invoice.id, contact.email);
    }
    const client = await S.loadClient(c, userId, invoice.client_id);
    await recordDispatchTx(c, {
      userId,
      message: m,
      clientId: client.id,
      provider: settings.sending_provider,
      providerMessageId: null,
      recipient: contact.email,
      cc,
      subject,
      bodyText,
      manual: true,
      at,
    });
  });
}
