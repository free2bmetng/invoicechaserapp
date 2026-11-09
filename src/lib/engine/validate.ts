// Input checks shared by the write APIs. Each returns the normalized value or throws
// a ValidationError with a user-facing reason.
import { DateTime } from "luxon";
import { isKnownCurrency, normalizeCurrency } from "@/lib/money";
import { ValidationError } from "./errors";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown, label = "Email"): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) throw new ValidationError(`${label} must be a valid address.`);
  return email;
}

export function cleanName(value: unknown, label: string, max = 200): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") throw new ValidationError(`${label} is required.`);
  if (name.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return name;
}

export function cleanIsoDate(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !DateTime.fromISO(text, { zone: "utc" }).isValid) {
    throw new ValidationError(`${label} must be a real date in YYYY-MM-DD form.`);
  }
  return text;
}

export function cleanAmountMinor(value: unknown, label = "Amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive whole number of minor units.`);
  }
  return value;
}

export function cleanCurrency(value: unknown): string {
  const code = normalizeCurrency(typeof value === "string" ? value : "");
  if (!isKnownCurrency(code)) throw new ValidationError("Currency must be a known ISO 4217 code, such as USD.");
  return code;
}

export function assertDueNotBeforeIssue(issueDate: string, dueDate: string): void {
  if (dueDate < issueDate) throw new ValidationError("The due date cannot be before the issue date.");
}

export function cleanInvoiceNumber(value: unknown): string {
  const number = typeof value === "string" ? value.trim() : "";
  if (number === "") throw new ValidationError("Invoice number is required.");
  if (number.length > 64) throw new ValidationError("Invoice number must be 64 characters or fewer.");
  return number;
}
