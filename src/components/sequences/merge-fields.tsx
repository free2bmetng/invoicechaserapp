// Merge fields: the chips that insert a field at the cursor, and TokenText, which shows {fields}
// inside saved or preset wording as the same chips. Server-safe (no hooks).
import { Fragment } from "react";
import { cx } from "@/components/ui";
import { MERGE_FIELDS, type MergeField } from "@/lib/types";

export const MERGE_FIELD_LABEL: Record<MergeField, string> = {
  client_name: "Client name",
  invoice_number: "Invoice number",
  amount: "Amount",
  currency: "Currency",
  due_date: "Due date",
  days_overdue: "Days overdue",
  pay_link: "Payment link",
  sender_name: "Your name",
  business_name: "Business name",
} as Record<MergeField, string>;

const CHIP = "inline-flex items-center rounded-[5px] bg-accent-soft px-1 font-medium text-accent";

function labelFor(name: string): string | null {
  return (MERGE_FIELDS as readonly string[]).includes(name) ? MERGE_FIELD_LABEL[name as MergeField] ?? name : null;
}

// "Quick note about invoice {invoice_number}" with the field drawn as a chip. Unknown fields stay as
// typed, so a mistake is visible.
export function TokenText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\{[a-z_]+\})/g);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        const m = /^\{([a-z_]+)\}$/.exec(part);
        const label = m ? labelFor(m[1]) : null;
        return label ? (
          <span key={i} className={cx(CHIP, "text-[0.92em] leading-[1.35]")} title={part}>{label}</span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </span>
  );
}

// The field library under the message. Each chip inserts its field where the cursor was last, in
// the subject or the message. The payment link can only go in the message.
export function MergeFieldChips({ onInsert, disabled }: { onInsert: (field: MergeField) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2">
      <p id="merge-fields-label" className="text-small font-medium text-ink-2">Insert a field at the cursor</p>
      <ul aria-labelledby="merge-fields-label" className="flex flex-wrap gap-1.5">
        {MERGE_FIELDS.map((f) => (
          <li key={f}>
            <button
              type="button"
              disabled={disabled}
              // Keep the cursor in the field: the click must not move focus before the insert reads it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(f)}
              title={`Inserts {${f}}`}
              className="inline-flex h-11 items-center gap-1 rounded-[8px] border border-line bg-surface px-2.5 text-small font-medium text-accent transition-colors hover:border-accent/40 hover:bg-accent-soft disabled:opacity-50 sm:h-8"
            >
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              {MERGE_FIELD_LABEL[f]}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
