"use client";

import { useEffect, useId, useRef, useState } from "react";
import { previewStepAction } from "@/app/actions/sequences";
import { Select, cx } from "@/components/ui";
import type { PayableChoice, PreviewOutcome, SequenceKind } from "@/lib/queries/sequences";
import type { Tone } from "@/lib/types";
import { PAY_LINK_PLACEHOLDER } from "@/lib/templates";
import { parseOffset, sendsPhrase, TONE_LABEL, type DraftStep } from "./state";

const DEBOUNCE_MS = 350;

// The body with the payment-link placeholder drawn as a link, so it reads like the real email.
function BodyText({ text }: { text: string }) {
  const parts = text.split(PAY_LINK_PLACEHOLDER);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <span className="font-medium text-accent underline underline-offset-2">{PAY_LINK_PLACEHOLDER}</span> : null}
        </span>
      ))}
    </>
  );
}

// The footer starts at the last "---" line, as the sender builds it.
function splitFooter(text: string): { body: string; footer: string | null } {
  const at = text.lastIndexOf("\n---\n");
  if (at < 0) return { body: text, footer: null };
  return { body: text.slice(0, at).trimEnd(), footer: text.slice(at + 5) };
}

// Renders the open step against a real invoice (or installment) as the user types, framed like an
// email client. The server renders with buildMessage in preview mode: no payment link is created,
// nothing is sent.
export function PreviewPanel({
  kind,
  choices,
  focused,
  stepNumber,
  stripeConnectedHint,
  fromAddress,
}: {
  kind: SequenceKind;
  choices: PayableChoice[];
  focused: DraftStep | null;
  stepNumber: number | null;
  stripeConnectedHint: boolean;
  fromAddress: string | null;
}) {
  const [payableId, setPayableId] = useState(choices[0]?.value ?? "");
  const [result, setResult] = useState<PreviewOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const uid = useId();
  const headingId = `${uid}-heading`;
  const selectId = `${uid}-payable`;

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
        <p className="text-card-title text-ink">Preview</p>
        <p className="text-body text-ink-2">
          {kind === "plan"
            ? "Installments appear here once an invoice has a payment plan. Set one up on an invoice to preview these steps."
            : "Add an invoice and the exact text of each step appears here, with the merge fields filled in."}
        </p>
      </div>
    );
  }

  const parts = shown && shown.ok ? splitFooter(shown.text) : null;

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-card-title text-ink">Preview</h2>
        <p role="status" aria-live="polite" className="text-small text-ink-3">{loading ? "Updating…" : null}</p>
      </div>
      <p className="-mt-2 text-small text-ink-3">
        {focused && stepNumber !== null
          ? `Step ${stepNumber} ${sendsPhrase(offsetText, kind)}. ${TONE_LABEL[tone as Tone]} tone.`
          : "Open a step to preview it."}
      </p>

      <label htmlFor={selectId} className="sr-only">{kind === "plan" ? "Installment to preview with" : "Invoice to preview with"}</label>
      <Select id={selectId} width="full" value={payableId} title={choices.find((c) => c.value === payableId)?.label}
        className="truncate" onChange={(e) => setPayableId(e.currentTarget.value)}>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </Select>

      {shown && shown.ok === false ? (
        <ul role="alert" className="grid gap-1 rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-body text-danger">
          {shown.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}

      {shown && shown.ok && parts ? (
        <article aria-label="Rendered email" className={cx("overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-card transition-opacity", loading && "opacity-60")}>
          <dl className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-b border-line bg-surface-2/60 px-4 py-3 text-small">
            <dt className="text-ink-3">From</dt>
            <dd className="min-w-0 truncate text-ink">
              {shown.from || "Your name"}
              {fromAddress ? <span className="text-ink-3"> &lt;{fromAddress}&gt;</span> : null}
            </dd>
            <dt className="text-ink-3">To</dt>
            <dd className="min-w-0 truncate text-ink">{shown.to}</dd>
            <dt className="text-ink-3">Subject</dt>
            <dd className="min-w-0 font-semibold text-ink">{shown.subject}</dd>
          </dl>
          <div className="px-4 py-4 text-body leading-6 whitespace-pre-wrap break-words text-ink">
            <BodyText text={parts.body} />
          </div>
          {parts.footer ? (
            <footer className="border-t border-line px-4 py-3 text-small whitespace-pre-wrap text-ink-3">{parts.footer}</footer>
          ) : null}
        </article>
      ) : null}

      {shown && shown.ok ? (
        <ul className="grid gap-1 text-small text-ink-3">
          <li>Uses a real invoice. Nothing is sent, and no payment link is created.</li>
          {shown.placeholderSender ? (
            <li>Your sender profile is incomplete, so the footer shows bracketed placeholders. Finish it in Settings.</li>
          ) : null}
          {shown.stripeConnected || stripeConnectedHint
            ? <li>The real payment link is created only when the reminder is sent.</li>
            : <li>Without Stripe, any line that uses the payment link is left out.</li>}
        </ul>
      ) : null}
    </section>
  );
}
