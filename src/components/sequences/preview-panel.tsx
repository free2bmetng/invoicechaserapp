"use client";

import { useEffect, useRef, useState } from "react";
import { previewStepAction } from "@/app/actions/sequences";
import { Field, Select, cx } from "@/components/ui";
import type { PayableChoice, PreviewOutcome, SequenceKind } from "@/lib/queries/sequences";
import type { Tone } from "@/lib/types";
import { parseOffset, sendsPhrase, TONE_LABEL, type DraftStep } from "./state";

const DEBOUNCE_MS = 350;

// Renders the focused step against a real invoice (or installment) as the user types. The server
// does the rendering with buildMessage in preview mode: no payment link is created, nothing is sent.
export function PreviewPanel({
  kind,
  choices,
  focused,
  position,
  stepNumber,
  stripeConnectedHint,
}: {
  kind: SequenceKind;
  choices: PayableChoice[];
  focused: DraftStep | null;
  position: number | null;
  stepNumber: number | null;
  stripeConnectedHint: boolean;
}) {
  const [payableId, setPayableId] = useState(choices[0]?.value ?? "");
  const [result, setResult] = useState<PreviewOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const tone = focused?.tone ?? "neutral";
  const subject = focused?.subject ?? "";
  const body = focused?.body ?? "";
  const offsetText = focused?.offsetText ?? "";
  const offset = parseOffset(offsetText);

  useEffect(() => {
    if (!focused || offset === null || !payableId) return;
    const mine = ++request.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const next = await previewStepAction({ kind, payableId, tone, subject, body, offsetDays: offset });
      if (mine === request.current) {
        setResult(next);
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    // A request that finishes after a newer edit is ignored (see the request counter above).
    return () => clearTimeout(timer);
    // The inputs that decide the rendered text are listed explicitly; the focused object changes identity on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, payableId, tone, subject, body, offsetText]);

  // A whole-day offset is required before anything can be rendered. Shown without a request.
  const shown: PreviewOutcome | null = offset === null
    ? { ok: false, errors: ["Enter a whole number of days to preview this step."] }
    : result;

  if (choices.length === 0) {
    return (
      <div className="grid gap-2 rounded-[var(--radius-lg)] border border-dashed border-line-strong p-5">
        <p className="text-[15px] font-semibold text-ink">Preview</p>
        <p className="text-[14px] leading-6 text-ink-2">
          {kind === "plan"
            ? "Installments appear here once an invoice has a payment plan. Set one up on an invoice to preview these steps."
            : "Add an invoice and the exact text of each step appears here, with the merge fields filled in."}
        </p>
      </div>
    );
  }

  return (
    <section id="preview" aria-labelledby="preview-heading" className="grid gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="grid gap-1">
        <h2 id="preview-heading" className="text-[15px] font-semibold text-ink">Live preview</h2>
        <p className="text-[13px] leading-5 text-ink-3">
          {focused && stepNumber !== null && position !== null
            ? `Step ${stepNumber} ${sendsPhrase(offsetText, kind)}. ${TONE_LABEL[tone as Tone]} tone.`
            : "Choose a step to preview it."}
        </p>
      </div>

      <Field id="preview-payable" label={kind === "plan" ? "Installment to preview with" : "Invoice to preview with"}>
        <Select id="preview-payable" value={payableId} title={choices.find((c) => c.value === payableId)?.label}
          className="truncate pr-9" onChange={(e) => setPayableId(e.currentTarget.value)}>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>
      </Field>

      <p role="status" aria-live="polite" className="text-[12.5px] text-ink-3">
        {loading ? "Updating the preview…" : "This uses a real invoice. Nothing is sent, and no payment link is created."}
      </p>

      {shown && shown.ok === false ? (
        <ul role="alert" className="grid gap-1 rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-[15px] leading-6 text-danger">
          {shown.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}

      {shown && shown.ok ? (
        <article className={cx("grid gap-3 rounded-[var(--radius-md)] border border-line bg-surface-2/60 p-4", loading && "opacity-60")} aria-label="Rendered message">
          <p className="text-[15px] font-semibold text-ink">{shown.subject}</p>
          <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-6 text-ink-2">{shown.text}</pre>
        </article>
      ) : null}

      {shown && shown.ok ? (
        <ul className="grid gap-1.5 text-[12.5px] leading-5 text-ink-3">
          {shown.placeholderSender ? (
            <li>Your sender profile is incomplete, so the footer shows bracketed placeholders. Finish it in Settings.</li>
          ) : null}
          {shown.stripeConnected || stripeConnectedHint
            ? <li>With Stripe connected, each reminder carries a payment link. Here it shows as a placeholder. The real link is created only when a reminder is sent.</li>
            : <li>Without Stripe, any line that uses {"{pay_link}"} is removed from the message.</li>}
        </ul>
      ) : null}
    </section>
  );
}
