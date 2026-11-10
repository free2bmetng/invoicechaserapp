"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, Textarea } from "@/components/ui";
import { LATE_PAYMENT_TERMS_SNIPPET } from "@/lib/templates";
import { Panel } from "./form-kit";

// The wording is generic and never inserted into invoices automatically. It is editable here so
// the user can adapt it before copying. Edits are not saved, because nothing stores them.
export function LatePaymentTermsCard() {
  const [text, setText] = useState(LATE_PAYMENT_TERMS_SNIPPET);
  const isStandard = text === LATE_PAYMENT_TERMS_SNIPPET;

  return (
    <Panel
      id="late-terms"
      title="Late-payment wording"
      description="Generic wording to copy into your own invoices. Invoice Chaser never adds it to an invoice and never charges fees or interest."
    >
      <div className="flex flex-col gap-3">
        <label htmlFor="lateTerms" className="sr-only">
          Late-payment wording
        </label>
        <Textarea
          id="lateTerms"
          aria-describedby="lateTerms-hint"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[7.5rem]"
        />
        <p id="lateTerms-hint" className="text-small text-ink-3">
          You can adapt it before you copy it. Edits stay on this page. This isn&apos;t legal advice, so check it with your
          adviser.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={text} label="Copy the late-payment wording" variant="text" text="Copy wording" />
          {isStandard ? null : (
            <Button type="button" variant="ghost" onClick={() => setText(LATE_PAYMENT_TERMS_SNIPPET)}>
              Use the standard wording
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
