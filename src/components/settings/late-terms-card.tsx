"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, Textarea } from "@/components/ui";
import { LATE_PAYMENT_TERMS_SNIPPET } from "@/lib/templates";
import { Callout, Field, fieldProps, SettingsCard } from "./form-kit";

// The wording is generic and never inserted into invoices automatically. It is editable here so
// the user can adapt it before copying. Edits are not saved, because nothing stores them.
export function LatePaymentTermsCard() {
  const [text, setText] = useState(LATE_PAYMENT_TERMS_SNIPPET);
  const isStandard = text === LATE_PAYMENT_TERMS_SNIPPET;

  return (
    <SettingsCard
      id="late-terms"
      level={3}
      title="Late-payment wording (optional)"
      description={
        <p>
          Generic text you can copy into your own invoices. Invoice Chaser never adds it to an invoice, and it never
          calculates late fees or interest.
        </p>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          id="lateTerms"
          label="Wording to copy"
          hint="You can edit the wording before you copy it. Edits stay on this page and are not saved."
        >
          <Textarea
            {...fieldProps("lateTerms", { hasHint: true })}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[7rem]"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={text} label="Copy the late-payment wording" />
          <Button type="button" size="sm" variant="ghost" disabled={isStandard} onClick={() => setText(LATE_PAYMENT_TERMS_SNIPPET)}>
            Use the standard wording
          </Button>
        </div>

        <Callout tone="info">
          This is generic wording, not legal advice. Check it with your own adviser before you put it on an invoice.
        </Callout>
      </div>
    </SettingsCard>
  );
}
