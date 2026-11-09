// The result every settings form action returns. Kept in its own module so the
// server actions and the client forms can both import it without a "use server" boundary.
export type FormStatus = "idle" | "saved" | "warning" | "error";

export interface FormState {
  status: FormStatus;
  // One calm sentence shown beside the save button.
  message: string;
  // Keyed by input name. Each message sits beside its field.
  fieldErrors: Record<string, string>;
}

export const IDLE_FORM_STATE: FormState = { status: "idle", message: "", fieldErrors: {} };

export function savedState(message: string): FormState {
  return { status: "saved", message, fieldErrors: {} };
}

export function warningState(message: string): FormState {
  return { status: "warning", message, fieldErrors: {} };
}

export function errorState(fieldErrors: Record<string, string>, message = ""): FormState {
  return { status: "error", message, fieldErrors };
}
