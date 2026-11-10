"use server";

// Server actions for sequences. Each export authenticates first, validates its input on the
// server, and then calls the engine. Preset steps take their text from TONE_PRESETS here, so the
// client cannot store edited wording under a preset tone.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { systemClock } from "@/lib/clock";
import { listSequences, saveSequence, ValidationError, validateSequence, type Tone } from "@/lib/engine";
import { renderStepPreview, type PreviewOutcome, type SequenceKind } from "@/lib/queries/sequences";
import { describeEngineError } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";
import { TONE_PRESETS, validateTemplate } from "@/lib/templates";
import { TONES } from "@/lib/types";
import { isUuidText, readText } from "@/components/invoices/form-state";

export interface SequenceStepDraft {
  id: string | null;
  offsetDays: number;
  tone: Tone;
  subject: string;
  body: string;
  requiresApproval: boolean;
  isFinalNotice: boolean;
}

export interface SequenceEditorData {
  id: string;
  name: string;
  kind: SequenceKind;
  isDefault: boolean;
  steps: SequenceStepDraft[];
}

export interface SaveSequenceResult {
  ok: boolean | null;
  message: string | null;
  formError: string | null;
  // Keyed by step index in the submitted order, so each step can show its own errors.
  stepErrors: Record<string, string[]>;
  sequence: SequenceEditorData | null;
}

const stepSchema = z.object({
  id: z.string().nullable(),
  offsetDays: z.number().int().min(-3650).max(3650),
  tone: z.enum(TONES),
  subject: z.string().max(300),
  body: z.string().max(10000),
  requiresApproval: z.boolean(),
  isFinalNotice: z.boolean(),
});

const payloadSchema = z.object({
  sequenceId: z.string(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["standard", "plan"]),
  isDefault: z.boolean(),
  steps: z.array(stepSchema).max(200),
});

const UNREADABLE = "Something in this sequence could not be read. Refresh the page and try again.";

async function loadSequenceData(userId: string, sequenceId: string): Promise<SequenceEditorData | null> {
  const all = await listSequences(userId);
  const found = all.find((s) => s.id === sequenceId);
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    kind: found.kind,
    isDefault: found.isDefault,
    steps: found.steps.map((s) => ({
      id: s.id,
      offsetDays: s.offsetDays,
      tone: s.tone as Tone,
      subject: s.subject,
      body: s.body,
      requiresApproval: s.requiresApproval,
      isFinalNotice: s.isFinalNotice,
    })),
  };
}

// "Step 2: ..." messages from the engine belong to step 2. Anything else is for the whole form.
function attachEngineErrors(messages: string[], stepErrors: Record<string, string[]>): string[] {
  const formLevel: string[] = [];
  for (const message of messages) {
    const match = /^Step (\d+): (.*)$/.exec(message);
    if (match) {
      const key = String(Number(match[1]) - 1);
      stepErrors[key] = [...(stepErrors[key] ?? []), match[2]];
    } else {
      formLevel.push(message);
    }
  }
  return formLevel;
}

export async function saveSequenceAction(_previous: SaveSequenceResult, formData: FormData): Promise<SaveSequenceResult> {
  const userId = await requireUserId();
  const fail = (formError: string | null, stepErrors: Record<string, string[]> = {}): SaveSequenceResult => ({
    ok: false, message: null, formError, stepErrors, sequence: null,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(formData, "payload"));
  } catch {
    return fail(UNREADABLE);
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) return fail(UNREADABLE);
  const payload = result.data;
  if (!isUuidText(payload.sequenceId)) return fail("That sequence could not be found. Refresh the page and try again.");

  // Text is checked here, per step. Presets are replaced with their own text.
  const stepErrors: Record<string, string[]> = {};
  const steps = payload.steps.map((s, index) => {
    const isPreset = s.tone !== "custom";
    const template = isPreset ? TONE_PRESETS[s.tone as "friendly" | "neutral" | "firm"] : { subject: s.subject, body: s.body };
    const check = validateTemplate(template, { preset: isPreset });
    if (!check.ok) stepErrors[String(index)] = check.errors;
    return {
      id: s.id ?? undefined,
      offsetDays: s.offsetDays,
      tone: s.tone as Tone,
      subject: template.subject,
      body: template.body,
      requiresApproval: s.requiresApproval,
      isFinalNotice: s.isFinalNotice,
    };
  });

  const order = validateSequence(payload.steps.map((s) => ({ offsetDays: s.offsetDays, isFinalNotice: s.isFinalNotice })));
  if (!order.ok) {
    const finalIndex = payload.steps.findIndex((s) => s.isFinalNotice);
    if (finalIndex >= 0) stepErrors[String(finalIndex)] = [...(stepErrors[String(finalIndex)] ?? []), ...order.errors];
    if (finalIndex < 0) return fail(order.errors.join(" "), stepErrors);
  }
  if (Object.keys(stepErrors).length > 0) {
    return fail("Fix the highlighted steps, then save again.", stepErrors);
  }

  let saved: { sequenceId: string; replanned: number };
  try {
    saved = await saveSequence(
      userId,
      { id: payload.sequenceId, name: payload.name, kind: payload.kind, isDefault: payload.isDefault, steps },
      systemClock,
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      const formLevel = attachEngineErrors(err.errors, stepErrors);
      return fail(formLevel.length > 0 ? formLevel.join(" ") : "Fix the highlighted steps, then save again.", stepErrors);
    }
    return fail(describeEngineError(err), stepErrors);
  }

  const data = await loadSequenceData(userId, saved.sequenceId);
  revalidatePath("/", "layout");
  const n = saved.replanned;
  return {
    ok: true,
    message: `Saved. ${n} ${n === 1 ? "invoice was" : "invoices were"} re-planned.`,
    formError: null,
    stepErrors: {},
    sequence: data,
  };
}

// Copies the default standard sequence into a new one, then opens its editor.
// Both arguments are required by useActionState and are not read: the copy source is always the default.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createSequenceAction(_previous: ActionNote, _formData: FormData): Promise<ActionNote> {
  const userId = await requireUserId();
  let sequenceId: string;
  try {
    const all = await listSequences(userId);
    const source = all.find((s) => s.kind === "standard" && s.isDefault);
    const saved = await saveSequence(
      userId,
      {
        name: "New sequence",
        kind: "standard",
        isDefault: false,
        steps: (source?.steps ?? []).map((s) => ({
          offsetDays: s.offsetDays,
          tone: s.tone as Tone,
          subject: s.subject,
          body: s.body,
          requiresApproval: s.requiresApproval,
          isFinalNotice: s.isFinalNotice,
        })),
      },
      systemClock,
    );
    sequenceId = saved.sequenceId;
  } catch (err) {
    return { ok: false, message: describeEngineError(err) };
  }
  revalidatePath("/", "layout");
  redirect(`/sequences/${sequenceId}`);
}

// Copies one of the user's sequences, steps and all, into a new sequence that is never the default,
// then opens its editor. Preset steps keep their tone, so they still use the preset wording.
export async function duplicateSequenceAction(_previous: ActionNote, formData: FormData): Promise<ActionNote> {
  const userId = await requireUserId();
  const sequenceId = readText(formData, "sequenceId").trim();
  if (!isUuidText(sequenceId)) return { ok: false, message: "That sequence could not be found." };
  let newId: string;
  try {
    const data = await loadSequenceData(userId, sequenceId);
    if (!data) return { ok: false, message: "That sequence could not be found." };
    const saved = await saveSequence(
      userId,
      {
        name: copyName(data.name),
        kind: data.kind,
        isDefault: false,
        steps: data.steps.map((s) => ({
          offsetDays: s.offsetDays,
          tone: s.tone,
          subject: s.subject,
          body: s.body,
          requiresApproval: s.requiresApproval,
          isFinalNotice: s.isFinalNotice,
        })),
      },
      systemClock,
    );
    newId = saved.sequenceId;
  } catch (err) {
    return { ok: false, message: describeEngineError(err) };
  }
  revalidatePath("/", "layout");
  redirect(`/sequences/${newId}`);
}

// "Default reminders" becomes "Default reminders (copy)", kept within the 120-character limit.
function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.slice(0, 120 - suffix.length)}${suffix}`;
}

export async function makeDefaultSequenceAction(_previous: ActionNote, formData: FormData): Promise<ActionNote> {
  const userId = await requireUserId();
  const sequenceId = readText(formData, "sequenceId").trim();
  if (!isUuidText(sequenceId)) return { ok: false, message: "That sequence could not be found." };
  try {
    const data = await loadSequenceData(userId, sequenceId);
    if (!data) return { ok: false, message: "That sequence could not be found." };
    const saved = await saveSequence(
      userId,
      {
        id: data.id,
        name: data.name,
        kind: data.kind,
        isDefault: true,
        steps: data.steps.map((s) => ({
          id: s.id ?? undefined,
          offsetDays: s.offsetDays,
          tone: s.tone,
          subject: s.subject,
          body: s.body,
          requiresApproval: s.requiresApproval,
          isFinalNotice: s.isFinalNotice,
        })),
      },
      systemClock,
    );
    revalidatePath("/", "layout");
    const n = saved.replanned;
    return { ok: true, message: `${data.name} is now the default. ${n} ${n === 1 ? "invoice was" : "invoices were"} re-planned.` };
  } catch (err) {
    return { ok: false, message: describeEngineError(err) };
  }
}

// The small result shape used by the one-button actions on the list.
export interface ActionNote {
  ok: boolean | null;
  message: string | null;
}

export interface PreviewRequest {
  kind: SequenceKind;
  payableId: string;
  tone: string;
  subject: string;
  body: string;
  offsetDays: number;
}

// The live preview. It renders the draft against a real invoice (or installment) and never creates a
// payment link, never sends, and never writes a row.
export async function previewStepAction(input: PreviewRequest): Promise<PreviewOutcome> {
  const userId = await requireUserId();
  if (input.kind !== "standard" && input.kind !== "plan") return { ok: false, errors: ["Unknown sequence kind."] };
  if (!isUuidText(input.payableId)) return { ok: false, errors: ["Choose an invoice to preview with."] };
  if (!Number.isInteger(input.offsetDays) || Math.abs(input.offsetDays) > 3650) {
    return { ok: false, errors: ["Enter a whole number of days to preview this step."] };
  }
  if (!(TONES as readonly string[]).includes(input.tone)) return { ok: false, errors: ["Choose a tone for this step."] };
  return renderStepPreview({
    userId,
    kind: input.kind,
    payableId: input.payableId,
    tone: input.tone,
    subject: String(input.subject).slice(0, 300),
    body: String(input.body).slice(0, 10000),
    offsetDays: input.offsetDays,
  });
}
