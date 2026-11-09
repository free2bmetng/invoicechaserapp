// Client-safe form state shared by the invoice, client, sequence and import forms.
// Server actions return this shape so each field can show its own message.
import type { ZodError } from "zod";

export interface FormState {
  // null before the first submit, true after a success, false after a failure.
  ok: boolean | null;
  message: string | null;
  fieldErrors: Record<string, string>;
  // The submitted values, so a failed submit keeps what the user typed.
  values: Record<string, string>;
}

export const IDLE_FORM_STATE: FormState = { ok: null, message: null, fieldErrors: {}, values: {} };

export function failedState(message: string | null, fieldErrors: Record<string, string>, values: Record<string, string>): FormState {
  return { ok: false, message, fieldErrors, values };
}

export function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function readTexts(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === "string");
}

// Copies the named fields into a values map. Multiple values are joined with commas.
export function valuesFrom(formData: FormData, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = readTexts(formData, name).join(",");
  return out;
}

export function listValue(values: Record<string, string>, name: string): string[] {
  return (values[name] ?? "").split(",").filter((v) => v !== "");
}

export function zodFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuidText(value: string): boolean {
  return UUID.test(value);
}
