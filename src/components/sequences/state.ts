// Client-safe state and step rules for the sequence editor. The step rules come from the engine's
// pure sequence module, so the UI and the engine agree on approval defaults and send order.
import type { SaveSequenceResult } from "@/app/actions/sequences";
import { defaultRequiresApproval, orderSteps } from "@/lib/engine/sequence";
import { TONE_PRESETS } from "@/lib/templates";
import type { Tone } from "@/lib/types";
import { describeOffset } from "@/components/invoices/format";

export const IDLE_SAVE_RESULT: SaveSequenceResult = { ok: null, message: null, formError: null, stepErrors: {}, sequence: null };

export const TONE_LABEL: Record<Tone, string> = { friendly: "Friendly", neutral: "Neutral", firm: "Firm", custom: "Custom" };
export const PRESET_TONES: readonly Tone[] = ["friendly", "neutral", "firm"];

export function isPresetTone(tone: Tone): boolean {
  return tone === "friendly" || tone === "neutral" || tone === "firm";
}

// The text a preset tone uses. Presets are read from TONE_PRESETS and never edited in place.
export function presetText(tone: Tone): { subject: string; body: string } | null {
  return isPresetTone(tone) ? TONE_PRESETS[tone as "friendly" | "neutral" | "firm"] : null;
}

// Whole numbers only. Negative means before the due date.
export function parseOffset(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && Math.abs(n) <= 3650 ? n : null;
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function anchorFor(kind: "standard" | "plan"): string {
  return kind === "plan" ? "the installment due date" : "the due date";
}

export function timingText(offset: number | null, kind: "standard" | "plan"): string {
  return offset === null ? "Enter a whole number of days" : describeOffset(offset, anchorFor(kind));
}

export interface DraftStep {
  key: string;
  id: string | null;
  offsetText: string;
  tone: Tone;
  subject: string;
  body: string;
  requiresApproval: boolean;
  // Once the user sets the approval switch, changing the offset no longer changes it.
  approvalTouched: boolean;
  isFinalNotice: boolean;
}

// Steps in send order: by offset, then by list order. The engine uses the same rule.
export function sendOrder(drafts: readonly DraftStep[]): DraftStep[] {
  const rules = drafts.map((d, index) => ({ d, index, offsetDays: parseOffset(d.offsetText) ?? 0, isFinalNotice: d.isFinalNotice }));
  return orderSteps(rules).map((r) => r.d);
}

export function lastKeyOf(drafts: readonly DraftStep[]): string | null {
  const ordered = sendOrder(drafts);
  return ordered.length > 0 ? ordered[ordered.length - 1].key : null;
}

// A final notice that is not the last step in send order. The UI shows it and blocks saving.
export function isFinalMisplaced(draft: DraftStep, lastKey: string | null): boolean {
  return draft.isFinalNotice && draft.key !== lastKey;
}

export function defaultApproval(offset: number | null, isFinal: boolean): boolean {
  return defaultRequiresApproval(offset ?? 0, isFinal);
}

export function newDraft(key: string, offset: number): DraftStep {
  const neutral = TONE_PRESETS.neutral;
  return {
    key,
    id: null,
    offsetText: String(offset),
    tone: "neutral",
    subject: neutral.subject,
    body: neutral.body,
    requiresApproval: defaultApproval(offset, false),
    approvalTouched: false,
    isFinalNotice: false,
  };
}

// The offset is stored as one signed number (the engine's form). The editor shows it as a choice of
// "before", "on" or "after" the due date, and a number of days.
export type When = "before" | "on" | "after";

export function whenOf(offsetText: string): { when: When; days: string } {
  const n = parseOffset(offsetText);
  if (n === null) return { when: "before", days: "" };
  if (n === 0) return { when: "on", days: "0" };
  return { when: n < 0 ? "before" : "after", days: String(Math.abs(n)) };
}

export function joinOffset(when: When, days: string): string {
  if (when === "on") return "0";
  const trimmed = days.trim();
  if (!/^\d+$/.test(trimmed)) return "";
  const n = Number(trimmed);
  if (n === 0) return "0";
  return when === "before" ? `-${n}` : String(n);
}

// Switching to "on" sets 0. Switching to before or after keeps the days, or starts at a sensible default.
export function changeWhen(current: string, when: When): string {
  if (when === "on") return "0";
  const { days } = whenOf(current);
  const keep = Number(days) > 0 ? days : when === "before" ? "3" : "7";
  return joinOffset(when, keep);
}

export function daysSummary(offsetText: string, kind: "standard" | "plan"): string {
  const n = parseOffset(offsetText);
  const anchor = kind === "plan" ? "installment due" : "due";
  if (n === null) return "Enter how many days";
  if (n === 0) return kind === "plan" ? "On the installment due date" : "On the due date";
  const days = Math.abs(n);
  return `${days} ${days === 1 ? "day" : "days"} ${n < 0 ? "before" : "after"} ${anchor}`;
}

function numberList(values: number[]): string {
  if (values.length <= 1) return values.map(String).join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

// A one-line cadence for a list card: "3 days before due · on the due date · 7 and 14 days after due".
export function describeCadence(offsets: number[], kind: "standard" | "plan"): string {
  if (offsets.length === 0) return "No steps, so nothing is sent with this sequence.";
  const anchor = kind === "plan" ? "installment due" : "due";
  const sorted = [...offsets].sort((a, b) => a - b);
  const before = sorted.filter((n) => n < 0).map((n) => Math.abs(n));
  const onDue = sorted.some((n) => n === 0);
  const after = sorted.filter((n) => n > 0);
  const parts: string[] = [];
  if (before.length > 0) parts.push(`${numberList(before)} ${before.length === 1 && before[0] === 1 ? "day" : "days"} before ${anchor}`);
  if (onDue) parts.push(kind === "plan" ? "on the installment due date" : "on the due date");
  if (after.length > 0) parts.push(`${numberList(after)} ${after.length === 1 && after[0] === 1 ? "day" : "days"} after ${anchor}`);
  return parts.join(" · ");
}

// The saved payload for the editor. The same function builds the baseline, so "unsaved changes" is an exact comparison.
export function serializeDrafts(args: { id: string; name: string; kind: "standard" | "plan"; isDefault: boolean; drafts: readonly DraftStep[] }): string {
  return JSON.stringify({
    sequenceId: args.id,
    name: args.name.trim(),
    kind: args.kind,
    isDefault: args.isDefault,
    steps: args.drafts.map((d) => ({
      id: d.id,
      offsetDays: parseOffset(d.offsetText) ?? 0,
      tone: d.tone,
      subject: d.subject,
      body: d.body,
      requiresApproval: d.requiresApproval,
      isFinalNotice: d.isFinalNotice,
    })),
  });
}

// A full sentence for the preview: "sends 3 days before the due date", "sends on the installment due date".
export function sendsPhrase(offsetText: string, kind: "standard" | "plan"): string {
  const n = parseOffset(offsetText);
  const anchor = kind === "plan" ? "the installment due date" : "the due date";
  if (n === null) return "sends on a day that is not yet set";
  if (n === 0) return `sends on ${anchor}`;
  const days = Math.abs(n);
  return `sends ${days} ${days === 1 ? "day" : "days"} ${n < 0 ? "before" : "after"} ${anchor}`;
}
