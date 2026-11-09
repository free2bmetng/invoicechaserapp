// The invoice fields of the edit form. Each field has a visible label, and its error sits beside it.
// Values come from the submitted state, or the defaults on first render. The amount accepts
// "1,234.50" and is formatted when it loses focus.
import { Field, Select, Textarea, TextInput } from "@/components/ui";
import { AmountInput } from "./amount-input";
import type { SequenceChoice } from "@/lib/queries/invoices";

export function InvoiceFields({
  values,
  defaults,
  errors,
  currencies,
  sequences,
  disabled = false,
  amountHint,
}: {
  values: Record<string, string>;
  defaults: Record<string, string>;
  errors: Record<string, string>;
  currencies: readonly string[];
  sequences: SequenceChoice[];
  disabled?: boolean;
  amountHint?: string;
}) {
  const v = (name: string): string => (values[name] !== undefined ? values[name] : (defaults[name] ?? ""));
  const err = (name: string) => errors[name];
  const invalid = (name: string) => (err(name) ? true : undefined);

  return (
    <div className="grid gap-5">
      <div className="grid max-w-2xl gap-5 sm:grid-cols-2">
        <Field id="invoiceNumber" label="Invoice number" error={err("invoiceNumber")}>
          <TextInput id="invoiceNumber" name="invoiceNumber" defaultValue={v("invoiceNumber")} disabled={disabled}
            aria-invalid={invalid("invoiceNumber")} autoComplete="off" maxLength={64} width="full" />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
          <Field id="amount" label="Amount" hint={amountHint} error={err("amount")}>
            <AmountInput id="amount" name="amount" defaultValue={v("amount")} disabled={disabled}
              aria-invalid={invalid("amount")} placeholder="0.00" className="text-right" />
          </Field>
          <Field id="currency" label="Currency" error={err("currency")}>
            <Select id="currency" name="currency" defaultValue={v("currency") || "USD"} disabled={disabled} aria-invalid={invalid("currency")} width="full">
              {currencies.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="grid max-w-2xl gap-5 sm:grid-cols-2">
        <Field id="issueDate" label="Issue date" error={err("issueDate")}>
          <TextInput id="issueDate" name="issueDate" type="date" defaultValue={v("issueDate")} disabled={disabled} aria-invalid={invalid("issueDate")} width="full" />
        </Field>
        <Field id="dueDate" label="Due date" error={err("dueDate")}>
          <TextInput id="dueDate" name="dueDate" type="date" defaultValue={v("dueDate")} disabled={disabled} aria-invalid={invalid("dueDate")} width="full" />
        </Field>
      </div>

      <Field
        id="sequenceId"
        label="Reminder sequence"
        error={err("sequenceId")}
      >
        <Select id="sequenceId" name="sequenceId" defaultValue={v("sequenceId")} disabled={disabled} aria-invalid={invalid("sequenceId")}>
          <option value="">Client&apos;s sequence, or the default</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.isDefault ? " (default)" : ""}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="notes" label="Notes" hint="Only you see these. They are never sent to the client." error={err("notes")}>
        <Textarea id="notes" name="notes" defaultValue={v("notes")} disabled={disabled} aria-invalid={invalid("notes")} className="min-h-[96px]" />
      </Field>
    </div>
  );
}
