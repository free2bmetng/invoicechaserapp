// Idempotent per-user setup: settings with defaults, the default standard sequence
// and the default plan sequence. Runs on every sign-in, so every insert is a no-op
// when the row already exists.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { TONE_PRESETS, type TonePreset } from "@/lib/templates";
import { defaultRequiresApproval } from "./sequence";
import * as S from "./store";
import type { Db } from "./store";

const STANDARD_STEPS: { offset: number; tone: TonePreset }[] = [
  { offset: -3, tone: "friendly" },
  { offset: 0, tone: "friendly" },
  { offset: 7, tone: "neutral" },
  { offset: 14, tone: "firm" },
];

// Per installment: three days before its due date, on its due date, and seven days after.
// The +7 step is skipped once the installment is paid (recordPayment cancels its unsent rows).
const PLAN_STEPS: { offset: number; tone: TonePreset }[] = [
  { offset: -3, tone: "friendly" },
  { offset: 0, tone: "friendly" },
  { offset: 7, tone: "neutral" },
];

async function ensureSequence(
  c: Db,
  userId: string,
  kind: "standard" | "plan",
  name: string,
  steps: readonly { offset: number; tone: TonePreset }[],
): Promise<void> {
  const created = await c.query<{ id: string }>(
    `insert into sequences (user_id, name, kind, is_default) values ($1, $2, $3, true)
     on conflict (user_id, kind) where is_default do nothing returning id`,
    [userId, name, kind],
  );
  const id = created.rows[0]?.id;
  if (!id) return;
  for (const [position, step] of steps.entries()) {
    const preset = TONE_PRESETS[step.tone];
    await c.query(
      `insert into sequence_steps (user_id, sequence_id, position, offset_days, tone, subject, body,
         requires_approval, is_final_notice)
       values ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
      [userId, id, position, step.offset, step.tone, preset.subject, preset.body, defaultRequiresApproval(step.offset, false)],
    );
  }
}

export async function provisionUser(userId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    await c.query(
      "insert into settings (user_id, updated_at) values ($1, $2) on conflict (user_id) do nothing",
      [userId, clock.now()],
    );
    await ensureSequence(c, userId, "standard", "Default reminders", STANDARD_STEPS);
    await ensureSequence(c, userId, "plan", "Payment plan reminders", PLAN_STEPS);
  });
}
