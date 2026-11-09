// Sequence editing. saveSequence reuses the existing validateSequence (sequence.ts),
// the template validators (templates.ts), deleteStepTx (plan.ts) and planInvoiceTx.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { TONES } from "@/lib/types";
import { validateTemplate } from "@/lib/templates";
import { deleteStepTx, planInvoiceTx } from "./plan";
import { defaultRequiresApproval, validateSequence } from "./sequence";
import { NotFoundError, ValidationError } from "./errors";
import * as S from "./store";
import { logEvent } from "./store";
import { cleanName } from "./validate";

export type Tone = (typeof TONES)[number];

export interface SequenceStepInput {
  id?: string;
  offsetDays: number;
  tone: Tone;
  subject: string;
  body: string;
  requiresApproval?: boolean;
  isFinalNotice?: boolean;
}

export interface SequenceInput {
  id?: string;
  name: string;
  kind: "standard" | "plan";
  isDefault: boolean;
  steps: SequenceStepInput[];
}

export interface SavedSequence {
  sequenceId: string;
  replanned: number;
}

export interface SequenceStepView {
  id: string;
  position: number;
  offsetDays: number;
  tone: string;
  subject: string;
  body: string;
  requiresApproval: boolean;
  isFinalNotice: boolean;
}

export interface SequenceView {
  id: string;
  name: string;
  kind: "standard" | "plan";
  isDefault: boolean;
  steps: SequenceStepView[];
}

function validateStepTexts(steps: readonly SequenceStepInput[]): string[] {
  const errors: string[] = [];
  steps.forEach((step, index) => {
    if (!(TONES as readonly string[]).includes(step.tone)) {
      errors.push(`Step ${index + 1} has an unknown tone.`);
      return;
    }
    // Presets never threaten legal action, fees, interest or collections. Custom text may, because the user wrote it.
    const check = validateTemplate({ subject: step.subject, body: step.body }, { preset: step.tone !== "custom" });
    if (!check.ok) errors.push(...check.errors.map((e) => `Step ${index + 1}: ${e}`));
  });
  return errors;
}

// Re-plans the invoices that use the saved sequence. The planner reads the default plan
// sequence for payment plans, and the standard precedence for open invoices.
async function replanAffected(c: PoolClient, userId: string, sequenceId: string, kind: "standard" | "plan", defaultChanged: boolean, at: Date): Promise<number> {
  let count = 0;
  if (kind === "plan") {
    const current = await c.query<{ is_default: boolean }>("select is_default from sequences where id = $1", [sequenceId]);
    if (!current.rows[0]?.is_default && !defaultChanged) return 0;
    const plans = await c.query<{ id: string }>(
      "select id from invoices where user_id = $1 and status = 'payment_plan' order by id",
      [userId],
    );
    for (const inv of plans.rows) {
      await planInvoiceTx(c, userId, inv.id, at);
      count += 1;
    }
    return count;
  }
  const opens = await c.query<{ id: string; client_id: string }>(
    "select id, client_id from invoices where user_id = $1 and status = 'open' order by id",
    [userId],
  );
  for (const inv of opens.rows) {
    if (!defaultChanged) {
      const invoice = await S.loadInvoice(c, userId, inv.id);
      const client = await S.loadClient(c, userId, inv.client_id);
      const effective = await S.standardSequenceFor(c, userId, invoice, client);
      if (effective.id !== sequenceId) continue;
    }
    await planInvoiceTx(c, userId, inv.id, at);
    count += 1;
  }
  return count;
}

export async function saveSequence(userId: string, input: SequenceInput, clock: Clock): Promise<SavedSequence> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const name = cleanName(input.name, "Sequence name", 120);
    const steps = input.steps ?? [];

    const rule = validateSequence(steps.map((s) => ({ offsetDays: s.offsetDays, isFinalNotice: !!s.isFinalNotice })));
    const errors = rule.ok ? validateStepTexts(steps) : rule.errors;
    if (errors.length > 0) throw new ValidationError(errors);

    let sequence: { id: string; kind: string; is_default: boolean };
    if (input.id) {
      const found = await c.query<{ id: string; kind: string; is_default: boolean }>(
        "select id, kind, is_default from sequences where id = $1 and user_id = $2",
        [input.id, userId],
      );
      if (!found.rows[0]) throw new NotFoundError("Sequence");
      sequence = found.rows[0];
      if (sequence.kind !== input.kind) throw new ValidationError("A sequence's kind cannot change.");
      await c.query("update sequences set name = $3 where id = $1 and user_id = $2", [sequence.id, userId, name]);
    } else {
      const created = await c.query<{ id: string; kind: string; is_default: boolean }>(
        "insert into sequences (user_id, name, kind, is_default) values ($1, $2, $3, false) returning id, kind, is_default",
        [userId, name, input.kind],
      );
      sequence = created.rows[0];
    }

    const wasDefault = sequence.is_default;
    if (input.isDefault && !wasDefault) {
      await c.query(
        "update sequences set is_default = false where user_id = $1 and kind = $2 and is_default and id <> $3",
        [userId, input.kind, sequence.id],
      );
      await c.query("update sequences set is_default = true where id = $1 and user_id = $2", [sequence.id, userId]);
    } else if (!input.isDefault && wasDefault) {
      throw new ValidationError("Choose another default sequence before unsetting this one.");
    }

    // Steps: remove the ones no longer listed, then rewrite positions in list order.
    const existing = await c.query<{ id: string }>("select id from sequence_steps where sequence_id = $1 and user_id = $2", [sequence.id, userId]);
    const existingIds = new Set(existing.rows.map((r) => r.id));
    for (const step of steps) {
      if (step.id && !existingIds.has(step.id)) throw new NotFoundError("Step");
    }
    const keep = new Set(steps.map((s) => s.id).filter((id): id is string => !!id));
    for (const id of existingIds) {
      if (!keep.has(id)) await deleteStepTx(c, userId, id, at);
    }
    await c.query("update sequence_steps set position = position + 100000 where sequence_id = $1 and user_id = $2", [sequence.id, userId]);
    for (const [position, step] of steps.entries()) {
      const requiresApproval = step.requiresApproval ?? defaultRequiresApproval(step.offsetDays, !!step.isFinalNotice);
      if (step.id) {
        await c.query(
          `update sequence_steps set position = $3, offset_days = $4, tone = $5, subject = $6, body = $7,
             requires_approval = $8, is_final_notice = $9 where id = $1 and user_id = $2`,
          [step.id, userId, position, step.offsetDays, step.tone, step.subject, step.body, requiresApproval, !!step.isFinalNotice],
        );
      } else {
        await c.query(
          `insert into sequence_steps (user_id, sequence_id, position, offset_days, tone, subject, body, requires_approval, is_final_notice)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [userId, sequence.id, position, step.offsetDays, step.tone, step.subject, step.body, requiresApproval, !!step.isFinalNotice],
        );
      }
    }

    const replanned = await replanAffected(c, userId, sequence.id, input.kind, input.isDefault !== wasDefault, at);
    await logEvent(c, { userId, type: "sequence_saved", detail: { sequence_id: sequence.id, steps: steps.length, replanned }, at });
    return { sequenceId: sequence.id, replanned };
  });
}

export async function listSequences(userId: string): Promise<SequenceView[]> {
  return withUser(userId, async (c) => {
    const seqs = await c.query<{ id: string; name: string; kind: "standard" | "plan"; is_default: boolean }>(
      "select id, name, kind, is_default from sequences where user_id = $1 order by kind, name",
      [userId],
    );
    const views: SequenceView[] = [];
    for (const s of seqs.rows) {
      const steps = await c.query<{
        id: string; position: number; offset_days: number; tone: string; subject: string; body: string;
        requires_approval: boolean; is_final_notice: boolean;
      }>(
        `select id, position, offset_days, tone, subject, body, requires_approval, is_final_notice
         from sequence_steps where sequence_id = $1 and user_id = $2 order by offset_days, position`,
        [s.id, userId],
      );
      views.push({
        id: s.id,
        name: s.name,
        kind: s.kind,
        isDefault: s.is_default,
        steps: steps.rows.map((r) => ({
          id: r.id,
          position: r.position,
          offsetDays: r.offset_days,
          tone: r.tone,
          subject: r.subject,
          body: r.body,
          requiresApproval: r.requires_approval,
          isFinalNotice: r.is_final_notice,
        })),
      });
    }
    return views;
  });
}

