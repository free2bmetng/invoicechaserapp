// The sender (spec section 4). Claims due rows, then handles each one under the
// user's lock: re-reads everything, applies the stop checks, the window and the
// daily cap, creates the payment link, sends once, and records the outcome.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withService } from "@/lib/db";
import { MessageError } from "@/lib/templates";
import {
  ProviderAmbiguousError,
  ProviderRefusedError,
  type EmailProvider,
  type OutgoingEmail,
  type PaymentProvider,
} from "@/lib/providers/types";
import { recordDispatchTx } from "./dispatch";
import { ensurePaymentLink } from "./payments";
import { renderForSend } from "./render";
import { settingsProfileComplete } from "./profile";
import * as S from "./store";
import { logEvent, encodePrior } from "./store";
import { assertValidZone, isInsideWindow, nextWindowOpening, startOfLocalDay, startOfNextLocalDay } from "./window";

export interface SenderDeps {
  clock: Clock;
  appUrl: string;
  emailFor(userId: string): Promise<EmailProvider>;
  paymentsFor(userId: string): Promise<PaymentProvider | null>;
  // A provider call that does not answer in time is treated as ambiguous. Default 30 s.
  sendTimeoutMs?: number;
}

export interface RunSenderOptions {
  batchSize?: number;
}

export interface RunSenderResult {
  claimed: number;
  sent: number;
  deferred: number;
  cancelled: number;
  held: number;
  failed: number;
  needsCheck: number;
}

type Outcome = "sent" | "deferred" | "cancelled" | "held" | "failed" | "needsCheck" | "noop";

const DEFAULT_BATCH = 50;
const STALE_MS = 15 * 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

interface PendingDispatch {
  clientId: string;
  provider: string;
  recipient: string;
  cc: string[];
  subject: string;
  bodyText: string;
}

interface CallState {
  providerCalled: boolean;
  accepted: boolean;
  providerId: string | null;
  pending: PendingDispatch | null;
}

export async function runSender(deps: SenderDeps, opts: RunSenderOptions = {}): Promise<RunSenderResult> {
  const batchSize = Math.min(Math.max(Math.floor(opts.batchSize ?? DEFAULT_BATCH), 1), 500);
  const result: RunSenderResult = { claimed: 0, sent: 0, deferred: 0, cancelled: 0, held: 0, failed: 0, needsCheck: 0 };

  // Step 0: a row stuck in sending for 15 minutes is unknown, so it becomes needs_check.
  result.needsCheck += await sweepStale(deps.clock.now());

  const claimed = await claimDue(deps.clock.now(), batchSize);
  result.claimed = claimed.length;
  for (const row of claimed) {
    const outcome = await processClaimed(deps, row);
    if (outcome !== "noop") result[outcome] += 1;
  }
  return result;
}

async function sweepStale(at: Date): Promise<number> {
  const cutoff = new Date(at.getTime() - STALE_MS);
  return withService(async (c) => {
    const r = await c.query(
      `with swept as (
         update scheduled_messages set status = 'needs_check', updated_at = $1
          where status = 'sending' and claimed_at < $2
          returning id, user_id, invoice_id
       )
       insert into events (user_id, invoice_id, type, detail, created_at)
       select user_id, invoice_id, 'needs_check',
              jsonb_build_object('scheduled_message_id', id, 'reason', 'stale_sending'), $1
       from swept`,
      [at, cutoff],
    );
    return r.rowCount ?? 0;
  });
}

// Claim is a single statement. SKIP LOCKED means overlapping runs never claim the same row.
async function claimDue(at: Date, limit: number): Promise<{ id: string; user_id: string }[]> {
  return withService(async (c) => {
    const r = await c.query<{ id: string; user_id: string }>(
      `with due as (
         select s.id from scheduled_messages s left join sequence_steps st on st.id = s.step_id
          where s.status = 'scheduled' and s.planned_at <= $1
          order by s.planned_at, st.position nulls last, s.id
          limit $2
          for update of s skip locked
       )
       update scheduled_messages m set status = 'sending', claimed_at = $1, updated_at = $1
         from due where m.id = due.id
       returning m.id, m.user_id`,
      [at, limit],
    );
    return r.rows.map((row) => ({ id: row.id, user_id: row.user_id }));
  });
}

async function processClaimed(deps: SenderDeps, row: { id: string; user_id: string }): Promise<Outcome> {
  const state: CallState = { providerCalled: false, accepted: false, providerId: null, pending: null };
  try {
    return await withService(async (c) => {
      await S.lockUser(c, row.user_id);
      return dispatchOne(deps, c, row.user_id, row.id, state);
    });
  } catch {
    return recoverAfterError(deps, row.user_id, row.id, state);
  }
}

// Failed before any provider call: release the claim so the next run retries it.
// After a provider call, the row is never released, because that could resend.
async function recoverAfterError(deps: SenderDeps, userId: string, id: string, state: CallState): Promise<Outcome> {
  if (!state.providerCalled) {
    await withService(async (c) => {
      await S.lockUser(c, userId);
      const m = await S.loadMessage(c, userId, id, true);
      if (m && m.status === "sending") {
        await S.updateMessage(c, userId, id, { status: "scheduled", claimed_at: null }, deps.clock.now());
        await logEvent(c, { userId, invoiceId: m.invoice_id, type: "send_error", detail: { scheduled_message_id: id, reason: "retry_next_run" }, at: deps.clock.now() });
      }
    }).catch(() => undefined);
    return "deferred";
  }
  if (state.accepted && state.pending && state.providerId) {
    try {
      await withService(async (c) => {
        await S.lockUser(c, userId);
        const m = await S.loadMessage(c, userId, id, true);
        if (!m || (m.status !== "sending" && m.status !== "needs_check")) return;
        const p = state.pending as PendingDispatch;
        await recordDispatchTx(c, {
          userId,
          message: m,
          clientId: p.clientId,
          provider: p.provider,
          providerMessageId: state.providerId,
          recipient: p.recipient,
          cc: p.cc,
          subject: p.subject,
          bodyText: p.bodyText,
          manual: false,
          at: deps.clock.now(),
        });
      });
      return "sent";
    } catch {
      // Fall through: the row is left for the stale sweep rather than resent.
    }
  }
  await withService(async (c) => {
    await S.lockUser(c, userId);
    const m = await S.loadMessage(c, userId, id, true);
    if (m && m.status === "sending") await markNeedsCheck(c, userId, m, "provider_outcome_unknown", deps.clock.now());
  }).catch(() => undefined);
  return "needsCheck";
}

async function cancelSending(c: PoolClient, userId: string, m: S.MessageRow, reason: string, at: Date): Promise<void> {
  await S.updateMessage(c, userId, m.id, { status: "cancelled", prior_status: "scheduled", claimed_at: null }, at);
  await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_cancelled", detail: { scheduled_message_id: m.id, reason }, at });
}

async function holdSending(c: PoolClient, userId: string, m: S.MessageRow, reason: string, at: Date): Promise<void> {
  await S.updateMessage(c, userId, m.id, { status: "held", prior_status: encodePrior({ base: "scheduled", userHold: false }), claimed_at: null }, at);
  await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_held", detail: { scheduled_message_id: m.id, reason }, at });
}

async function deferRow(c: PoolClient, userId: string, m: S.MessageRow, plannedAt: Date, reason: string, at: Date): Promise<void> {
  await S.updateMessage(c, userId, m.id, { status: "scheduled", planned_at: plannedAt, claimed_at: null }, at);
  await logEvent(c, {
    userId,
    invoiceId: m.invoice_id,
    type: "message_deferred",
    detail: { scheduled_message_id: m.id, reason, planned_at: plannedAt.toISOString() },
    at,
  });
}

async function failRow(c: PoolClient, userId: string, m: S.MessageRow, reason: string, at: Date): Promise<void> {
  await S.updateMessage(c, userId, m.id, { status: "failed", claimed_at: null }, at);
  await logEvent(c, { userId, invoiceId: m.invoice_id, type: "message_failed", detail: { scheduled_message_id: m.id, reason }, at });
}

async function markNeedsCheck(c: PoolClient, userId: string, m: S.MessageRow, reason: string, at: Date): Promise<void> {
  await S.updateMessage(c, userId, m.id, { status: "needs_check" }, at);
  await logEvent(c, { userId, invoiceId: m.invoice_id, type: "needs_check", detail: { scheduled_message_id: m.id, reason }, at });
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderAmbiguousError(`No answer from the provider within ${ms} ms.`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function dispatchOne(deps: SenderDeps, c: PoolClient, userId: string, id: string, state: CallState): Promise<Outcome> {
  // Re-read everything under the lock. A stop committed before this point is seen here.
  const m = await S.loadMessage(c, userId, id, true);
  if (!m || m.status !== "sending") return "noop";
  const at = deps.clock.now();

  const invoice = await S.loadInvoice(c, userId, m.invoice_id);
  const installment = m.installment_id ? await S.loadInstallment(c, userId, m.installment_id) : null;
  const client = await S.loadClient(c, userId, invoice.client_id);
  const contact = m.contact_id ? await S.loadContact(c, userId, m.contact_id) : null;
  const step = m.step_id ? await S.loadStep(c, userId, m.step_id) : null;
  const settings = await S.loadSettings(c, userId);

  // Spec 3.8: no message is sent before onboarding is finished, whatever a row says.
  if (!settings.onboarding_done) {
    await cancelSending(c, userId, m, "onboarding_incomplete", at);
    return "cancelled";
  }
  if (!step) {
    await S.skipRow(c, userId, m, "step_removed", at);
    return "cancelled";
  }
  const payableOpen = installment
    ? invoice.status === "payment_plan" && installment.status === "open"
    : invoice.status === "open";
  if (!payableOpen) {
    await cancelSending(c, userId, m, "payable_not_open", at);
    return "cancelled";
  }
  if (!contact) {
    await failRow(c, userId, m, "contact_missing", at);
    return "failed";
  }
  if (S.holdOn(client, contact)) {
    await holdSending(c, userId, m, client.reply_held_at ? "reply" : "contact_hold", at);
    return "held";
  }

  const senderName = settings.sender_name.trim();
  const businessName = settings.business_name.trim();
  const postalAddress = settings.postal_address.trim();
  const domain = (settings.sending_domain ?? "").trim();
  if (!settingsProfileComplete(settings) || domain === "") {
    await failRow(c, userId, m, "sender_profile_incomplete", at);
    return "failed";
  }

  const timezone = client.timezone || settings.timezone;
  try {
    assertValidZone(timezone);
  } catch {
    await failRow(c, userId, m, "invalid_timezone", at);
    return "failed";
  }
  const startHour = settings.send_window_start;
  const endHour = settings.send_window_end;
  if (!isInsideWindow(at, timezone, startHour, endHour)) {
    await deferRow(c, userId, m, nextWindowOpening(at, timezone, startHour, endHour), "outside_window", at);
    return "deferred";
  }

  // Daily cap, counted per the user's local day over dispatched messages only.
  const dayStart = startOfLocalDay(at, settings.timezone);
  const nextDay = startOfNextLocalDay(at, settings.timezone);
  const counted = await c.query<{ n: string }>(
    "select count(*)::text as n from message_log where user_id = $1 and sent_at >= $2 and sent_at < $3",
    [userId, dayStart, nextDay],
  );
  if (Number(counted.rows[0].n) >= settings.daily_cap) {
    await deferRow(c, userId, m, nextWindowOpening(nextDay, timezone, startHour, endHour), "daily_cap", at);
    return "deferred";
  }

  const payments = await deps.paymentsFor(userId);
  let payLink: string | null = null;
  if (payments) {
    try {
      payLink = await ensurePaymentLink(c, userId, payments, { invoice, installment }, at);
    } catch {
      await failRow(c, userId, m, "payment_link_failed", at);
      return "failed";
    }
  }

  let message: { subject: string; text: string };
  try {
    message = renderForSend({
      settings,
      client,
      invoice,
      payable: installment ?? invoice,
      step,
      message: m,
      payLink,
      stripeConnected: payments !== null,
    });
  } catch (err) {
    if (err instanceof MessageError) {
      await failRow(c, userId, m, `message_error:${err.name}`, at);
      return "failed";
    }
    throw err;
  }

  let emailProvider: EmailProvider;
  try {
    emailProvider = await deps.emailFor(userId);
  } catch {
    await failRow(c, userId, m, "email_provider_unavailable", at);
    return "failed";
  }

  const userRow = await c.query<{ email: string }>("select email from users where id = $1", [userId]);
  const replyTo = userRow.rows[0]?.email ?? "";
  const cc = await S.ccEmailsFor(c, userId, invoice.id, contact.email);
  const outgoing: OutgoingEmail = {
    from: { name: senderName, address: `invoices@${domain}` },
    replyTo,
    to: contact.email,
    cc,
    subject: message.subject,
    text: message.text,
    idempotencyKey: m.id,
  };

  // Written before the call, in the same transaction, so a manual resolution can
  // show what was sent. A crash before commit leaves no record, which is safe.
  await logEvent(c, {
    userId,
    invoiceId: invoice.id,
    clientId: client.id,
    type: "send_attempt",
    detail: {
      scheduled_message_id: m.id,
      provider: emailProvider.name,
      subject: message.subject,
      body_snapshot: message.text,
      recipient: contact.email,
      cc,
    },
    at,
  });

  state.pending = {
    clientId: client.id,
    provider: emailProvider.name,
    recipient: contact.email,
    cc,
    subject: message.subject,
    bodyText: message.text,
  };
  state.providerCalled = true;
  let providerMessageId: string;
  try {
    const res = await withDeadline(emailProvider.send(outgoing), deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    providerMessageId = res.providerMessageId;
  } catch (err) {
    if (err instanceof ProviderRefusedError) {
      await failRow(c, userId, m, "provider_refused", at);
      return "failed";
    }
    // Timeout, dropped connection or unknown error: the provider may have accepted it.
    await markNeedsCheck(c, userId, m, "provider_outcome_unknown", at);
    return "needsCheck";
  }
  state.accepted = true;
  state.providerId = providerMessageId;

  await recordDispatchTx(c, {
    userId,
    message: m,
    clientId: client.id,
    provider: emailProvider.name,
    providerMessageId,
    recipient: contact.email,
    cc,
    subject: message.subject,
    bodyText: message.text,
    manual: false,
    at,
  });
  return "sent";
}
