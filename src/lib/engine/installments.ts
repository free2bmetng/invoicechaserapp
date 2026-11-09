// Payment plan validation (spec 3.2). Pure, so the UI and the engine share it.
import { DateTime } from "luxon";

export interface InstallmentInput {
  dueDate: string; // YYYY-MM-DD
  amountMinor: number;
}

export type InstallmentValidation = { ok: true } | { ok: false; errors: string[] };

export function validateInstallments(totalMinor: number, items: readonly InstallmentInput[]): InstallmentValidation {
  const errors: string[] = [];
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) errors.push("The invoice amount must be positive.");
  if (items.length < 2) errors.push("A payment plan needs at least 2 installments.");

  let sum = 0;
  items.forEach((item, index) => {
    const label = `Installment ${index + 1}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) || !DateTime.fromISO(item.dueDate, { zone: "utc" }).isValid) {
      errors.push(`${label} needs a valid date (YYYY-MM-DD).`);
    }
    if (!Number.isInteger(item.amountMinor) || item.amountMinor <= 0) {
      errors.push(`${label} needs a positive amount in minor units.`);
    } else {
      sum += item.amountMinor;
    }
    if (index > 0 && items[index - 1].dueDate >= item.dueDate) {
      errors.push(`${label} must fall after installment ${index}. Dates must strictly increase.`);
    }
  });

  if (errors.length === 0 && sum !== totalMinor) {
    errors.push(`The installments add up to ${sum} minor units, but the invoice is ${totalMinor}. They must match exactly.`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
