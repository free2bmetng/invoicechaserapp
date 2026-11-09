// Planning: one row per planned step, keyed by dedupe_key. Replanning updates
// unsent rows in place, never touches dispatched rows, and skips steps whose
// planned time has passed.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { MESSAGE_GENERATING_INVOICE_STATUSES, type MessageStatus } from "@/lib/types";
import { standardDedupeKey, planDedupeKey } from "./dedupe";
import { InvalidStateError, NotFoundError } from "./errors";
import { settingsProfileComplete } from "./profile";
import * as S from "./store";
import { assertValidZone, plannedAtFor } from "./window";
import { unsentBase, encodePrior, decodePrior, logEvent, type Base } from "./store";

interface Desired {
  dedupe: string;
  step: S.StepRow;
  installmentId: string | null;
  plannedAt: Date;
}

const OBSOLETE: MessageStatus[] = ["pending_approval", "scheduled", "held", "cancelled", "failed"];

async function desiredSteps(
  c: PoolClient,
  userId: string,
  invoice: S.InvoiceRow,
  client: S.ClientRow,
  zone: string,
  startHour: number,
): Promise<Desired[]> {
  const out: Desired[] = [];
  if (invoice.status === "payment_plan") {
    const seq = await S.defaultSequence(c, userId, "plan");
    const steps = await S.stepsOf(c, userId, seq.id);
    for (const inst of await S.installmentsOf(c, userId, invoice.id)) {
      if (inst.status !== "open") continue;
      for (const step of steps) {
        out.push({
          dedupe: planDedupeKey(inst.id, step.id),
          step,
          installmentId: inst.id,
          plannedAt: plannedAtFor(inst.due_date, step.offset_days, zone, startHour),
        });
      }
    }
    return out;
  }
  const seq = await S.standardSequenceFor(c, userId, invoice, client);
  for (const step of await S.stepsOf(c, userId, seq.id)) {
    out.push({
      dedupe: standardDedupeKey(invoice.id, step.id),
      step,
      installmentId: null,
      plannedAt: plannedAtFor(invoice.due_date, step.offset_days, zone, startHour),
    });
  }
  return out;
}

interface Ctx {
  userId: string;
  at: Date;
  ruleB: boolean;
  holdOn: boolean;
  contact: S.ContactRow;
  invoiceId: string;
}

async function insertPlanned(c: PoolClient, d: Desired, ctx: Ctx): Promise<void> {
  const past = d.plannedAt.getTime() <= ctx.at.getTime();
  let status: MessageStatus;
  let prior: string | null = null;
  if (past) {
    status = "skipped";
  } else {
    const base = unsentBase({ base: "pending_approval", userHold: false }, d.step.requires_approval, ctx.ruleB);
    if (ctx.holdOn) {
      status = "held";
      prior = encodePrior({ base, userHold: false });
    } else {
      status = base;
    }
  }
  await c.query(
    `insert into scheduled_messages (user_id, invoice_id, installment_id, step_id, contact_id, planned_at, status,
       prior_status, requires_approval, dedupe_key, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     on conflict do nothing`,
    [
      ctx.userId,
      ctx.invoiceId,
      d.installmentId,
      d.step.id,
      ctx.contact.id,
      d.plannedAt,
      status,
      prior,
      d.step.requires_approval,
      d.dedupe,
      ctx.at,
    ],
  );
  if (past) {
    await logEvent(c, {
      userId: ctx.userId,
      invoiceId: ctx.invoiceId,
      type: "message_skipped",
      detail: { dedupe_key: d.dedupe, reason: "passed_at_planning" },
      at: ctx.at,
    });
  }
}

// Base for a row whose step's approval flag may have changed.
function reconcileBase(prior: Base, storedRequires: boolean, newRequires: boolean, ruleB: boolean, userHold: boolean): Base {
  let base = prior;
  if (base === "scheduled" && newRequires && !storedRequires) base = "pending_approval";
  return unsentBase({ base, userHold }, newRequires, ruleB);
}

async function reconcileExisting(c: PoolClient, row: S.MessageRow, d: Desired, ctx: Ctx): Promise<void> {
  const { userId, at, ruleB, holdOn, contact } = ctx;
  const past = d.plannedAt.getTime() <= at.getTime();
  const reqFlag = d.step.requires_approval;

  switch (row.status) {
    case "sent":
    case "delivered":
    case "bounced":
    case "needs_check":
    case "sending":
    case "failed":
    case "skipped":
      return;

    case "scheduled": {
      if (past && row.planned_at.getTime() > at.getTime()) {
        await S.skipRow(c, userId, row, "passed_at_replan", at);
        return;
      }
      const planned = past ? row.planned_at : d.plannedAt;
      let status: MessageStatus = "scheduled";
      let requires = row.requires_approval;
      if (reqFlag && !row.requires_approval) {
        status = "pending_approval";
        requires = true;
      } else if (!reqFlag) {
        requires = false;
      }
      let prior: string | null = null;
      if (holdOn) {
        status = "held";
        prior = encodePrior({ base: requires ? "pending_approval" : "scheduled", userHold: false });
      }
      await S.updateMessage(c, userId, row.id, {
        planned_at: planned,
        status,
        prior_status: prior,
        requires_approval: requires,
        contact_id: contact.id,
      }, at);
      return;
    }

    case "pending_approval": {
      if (past) {
        await S.skipRow(c, userId, row, "passed_at_replan", at);
        return;
      }
      const base = unsentBase({ base: "pending_approval", userHold: false }, reqFlag, ruleB);
      await S.updateMessage(c, userId, row.id, {
        planned_at: d.plannedAt,
        status: holdOn ? "held" : base,
        prior_status: holdOn ? encodePrior({ base, userHold: false }) : null,
        requires_approval: reqFlag,
        contact_id: contact.id,
      }, at);
      return;
    }

    case "held": {
      if (past) {
        await S.skipRow(c, userId, row, "passed_at_replan", at);
        return;
      }
      const prior = decodePrior(row.prior_status);
      const base = reconcileBase(prior.base, row.requires_approval, reqFlag, ruleB, prior.userHold);
      const stillHeld = prior.userHold || holdOn;
      await S.updateMessage(c, userId, row.id, {
        planned_at: d.plannedAt,
        status: stillHeld ? "held" : base,
        prior_status: stillHeld ? encodePrior({ base, userHold: prior.userHold }) : null,
        requires_approval: reqFlag,
        contact_id: contact.id,
      }, at);
      return;
    }

    case "cancelled": {
      if (!row.prior_status) return;
      if (past) {
        await S.skipRow(c, userId, row, "passed_at_replan", at);
        return;
      }
      const prior = decodePrior(row.prior_status);
      const base = reconcileBase(prior.base, row.requires_approval, reqFlag, ruleB, prior.userHold);
      await S.updateMessage(c, userId, row.id, {
        planned_at: d.plannedAt,
        prior_status: encodePrior({ base, userHold: prior.userHold }),
        requires_approval: reqFlag,
        contact_id: contact.id,
      }, at);
      return;
    }
  }
}

// Plans or replans one invoice. Inside the caller's transaction and lock.
export async function planInvoiceTx(c: PoolClient, userId: string, invoiceId: string, at: Date): Promise<void> {
  const invoice = await S.loadInvoice(c, userId, invoiceId);
  if (!(MESSAGE_GENERATING_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
    await S.cancelUnsentWhere(c, userId, { invoiceId }, at, `invoice_${invoice.status}`);
    return;
  }
  const settings = await S.loadSettings(c, userId);
  // Spec 3.8: nothing is planned until onboarding is finished. completeOnboarding plans everything then.
  if (!settings.onboarding_done) return;
  // Nothing is created for an incomplete sender profile (spec 3.3).
  if (!settingsProfileComplete(settings)) return;

  const client = await S.loadClient(c, userId, invoice.client_id);
  const zone = client.timezone || settings.timezone;
  assertValidZone(zone);

  const contact = await S.primaryContactFor(c, userId, invoice.id, client.id);
  if (!contact) {
    await logEvent(c, {
      userId,
      invoiceId,
      type: "planning_blocked",
      detail: { reason: "no_primary_contact" },
      at,
    });
    return;
  }

  const desired = await desiredSteps(c, userId, invoice, client, zone, settings.send_window_start);
  const ctx: Ctx = {
    userId,
    at,
    ruleB: await S.ruleBApplies(c, userId, client),
    holdOn: S.holdOn(client, contact),
    contact,
    invoiceId,
  };

  const existing = await S.messagesForInvoice(c, userId, invoiceId);
  const byKey = new Map(existing.map((row) => [row.dedupe_key, row]));
  const seen = new Set<string>();

  for (const d of desired) {
    seen.add(d.dedupe);
    const row = byKey.get(d.dedupe);
    if (row) await reconcileExisting(c, row, d, ctx);
    else await insertPlanned(c, d, ctx);
  }

  // A row whose step is no longer part of the sequence can never be sent.
  for (const row of existing) {
    if (!seen.has(row.dedupe_key) && OBSOLETE.includes(row.status)) {
      await S.skipRow(c, userId, row, "step_removed", at);
    }
  }
}

export async function planInvoice(userId: string, invoiceId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    await planInvoiceTx(c, userId, invoiceId, clock.now());
  });
}

// Replans every invoice that can still produce messages. Called after sequence
// edits. Idempotent, so it is safe to over-call.
export async function replanSequence(userId: string, sequenceId: string, clock: Clock): Promise<number> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const seq = await c.query("select id from sequences where id = $1 and user_id = $2", [sequenceId, userId]);
    if (!seq.rows[0]) throw new NotFoundError("Sequence");
    const at = clock.now();
    const { rows } = await c.query<{ id: string }>(
      "select id from invoices where user_id = $1 and status in ('open', 'payment_plan') order by id",
      [userId],
    );
    for (const row of rows) await planInvoiceTx(c, userId, row.id, at);
    return rows.length;
  });
}

// Deleting a step cancels its unsent rows. Dispatched invoice-level rows keep the
// step reference (the schema cannot null it), so the step is refused in that case.
export async function deleteStepTx(c: PoolClient, userId: string, stepId: string, at: Date): Promise<void> {
  const step = await S.loadStep(c, userId, stepId);
  if (!step) throw new NotFoundError("Step");
  await S.lockUser(c, userId);
  const { rows } = await c.query<{
    id: string;
    invoice_id: string;
    installment_id: string | null;
    status: MessageStatus;
    dedupe_key: string;
  }>(
    "select id, invoice_id, installment_id, status, dedupe_key from scheduled_messages where step_id = $1 and user_id = $2 for update",
    [stepId, userId],
  );
  if (rows.some((r) => r.status === "sending")) {
    throw new InvalidStateError("A message for this step is being sent. Try again in a moment.");
  }
  if (rows.some((r) => r.installment_id === null && S.DISPATCHED.includes(r.status))) {
    throw new InvalidStateError("This step has sent messages, so it cannot be deleted. Change its offset or template instead.");
  }
  for (const r of rows) {
    if (r.installment_id) {
      const unsent = r.status === "pending_approval" || r.status === "scheduled" || r.status === "held" || r.status === "failed";
      await c.query(
        `update scheduled_messages set step_id = null, status = $3, prior_status = null, updated_at = $4
         where id = $1 and user_id = $2`,
        [r.id, userId, unsent ? "cancelled" : r.status, at],
      );
      if (unsent) {
        await logEvent(c, { userId, invoiceId: r.invoice_id, type: "message_cancelled", detail: { scheduled_message_id: r.id, reason: "step_deleted" }, at });
      }
    } else {
      await logEvent(c, { userId, invoiceId: r.invoice_id, type: "message_deleted", detail: { dedupe_key: r.dedupe_key, status: r.status, reason: "step_deleted" }, at });
      await c.query("delete from scheduled_messages where id = $1 and user_id = $2", [r.id, userId]);
    }
  }
  await c.query("delete from sequence_steps where id = $1 and user_id = $2", [stepId, userId]);
  await logEvent(c, { userId, type: "step_deleted", detail: { step_id: stepId, rows: rows.length }, at });
}

export async function deleteStep(userId: string, stepId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    await deleteStepTx(c, userId, stepId, clock.now());
  });
}
