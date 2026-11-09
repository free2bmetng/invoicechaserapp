// Pure sequence rules: default approval, send order and the final-notice check.
import { ValidationError } from "./errors";

export interface StepRule {
  offsetDays: number;
  isFinalNotice: boolean;
}

// Spec 3.2: approval is on for any offset above 14 days and for any final notice.
export function defaultRequiresApproval(offsetDays: number, isFinalNotice: boolean): boolean {
  return offsetDays > 14 || isFinalNotice;
}

// Steps are sent in offset order. Equal offsets keep their list order.
export function orderSteps<T extends StepRule>(listOrder: readonly T[]): T[] {
  return listOrder
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.offsetDays - b.step.offsetDays || a.index - b.index)
    .map((entry) => entry.step);
}

export type SequenceValidation = { ok: true } | { ok: false; errors: string[] };

// The list is in the user's order. A final notice must be the last step in send
// order, so any step after it is rejected.
export function validateSequence(listOrder: readonly StepRule[]): SequenceValidation {
  const errors: string[] = [];
  listOrder.forEach((step, index) => {
    if (!Number.isInteger(step.offsetDays)) {
      errors.push(`Step ${index + 1} must use a whole number of days.`);
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  const ordered = orderSteps(listOrder);
  const finalIndex = ordered.findIndex((step) => step.isFinalNotice);
  if (finalIndex !== -1 && finalIndex !== ordered.length - 1) {
    errors.push("A final-notice step must be the last step. Move it to the latest offset or remove the steps after it.");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function assertValidSequence(listOrder: readonly StepRule[]): void {
  const result = validateSequence(listOrder);
  if (!result.ok) throw new ValidationError(result.errors);
}
