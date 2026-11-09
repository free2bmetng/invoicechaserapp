"use client";

// The amount field. Accepts what people type ("1,234.50", "£1 234.50") and, on blur, rewrites it
// in the currency's own format ("1,234.50"). The server action normalises again before the strict
// parser, so the field works without JavaScript too. Uncontrolled unless value/onChange are given.
import type { InputHTMLAttributes } from "react";
import { TextInput, cx } from "@/components/ui";
import { formatMoneyInput } from "./money-input";

export function AmountInput({
  currency,
  className,
  onBlur,
  onValueChange,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  // The currency to format for. When omitted, the form's "currency" field is read.
  currency?: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <TextInput
      {...props}
      inputMode="decimal"
      autoComplete="off"
      width="full"
      className={cx("num", className)}
      onChange={(e) => {
        props.onChange?.(e);
        onValueChange?.(e.currentTarget.value);
      }}
      onBlur={(e) => {
        const input = e.currentTarget;
        const field = input.form?.elements.namedItem("currency");
        const code = currency ?? (field instanceof HTMLSelectElement || field instanceof HTMLInputElement ? field.value : "");
        if (code) {
          const formatted = formatMoneyInput(input.value, code);
          if (formatted !== input.value) {
            if (onValueChange) onValueChange(formatted);
            else input.value = formatted;
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
