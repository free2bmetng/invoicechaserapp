"use client";

// One step of the sequence editor: a collapsed row in the step table (day, timing, tone, subject,
// approval), which opens in place into its editor. The editor controls nothing itself: it reports
// changes to the sequence editor, which owns the drafts and keeps one step open at a time.
import { useLayoutEffect, useRef } from "react";
import { Badge, Button, Field, Switch, cx } from "@/components/ui";
import type { Tone } from "@/lib/types";
import type { MergeField } from "@/lib/types";
import type { SequenceKind } from "@/lib/queries/sequences";
import { MergeFieldChips, TokenText } from "./merge-fields";
import {
  PRESET_TONES, TONE_LABEL, changeWhen, dayBadge, defaultApproval, dotClass, isFinalMisplaced, isPresetTone, joinOffset,
  parseOffset, presetText, timingText, whenOf, type DraftStep, type When,
} from "./state";

const WHEN_OPTIONS: { value: When; label: string }[] = [
  { value: "before", label: "Before due" },
  { value: "on", label: "On due date" },
  { value: "after", label: "After due" },
];

// Same look as the TextInput primitive. A local class because the primitives do not take a ref,
// and inserting a field at the cursor needs one.
const FIELD =
  "rounded-[10px] border border-line-strong bg-surface px-3 text-[14px] text-ink placeholder:text-ink-3 " +
  "transition-[border-color,box-shadow] duration-150 hover:border-control-border focus:border-accent aria-[invalid=true]:border-danger";

// The desktop columns of a collapsed row. The table header in the editor uses the same template.
export const STEP_COLUMNS = "sm:grid sm:grid-cols-[0.875rem_3rem_minmax(0,1fr)_5.5rem_auto_1rem] sm:items-center sm:gap-x-4";

export interface StepRowProps {
  index: number;
  kind: SequenceKind;
  draft: DraftStep;
  open: boolean;
  canBeFinal: boolean;
  lastKey: string | null;
  serverErrors: string[];
  onToggle: () => void;
  onChange: (patch: Partial<DraftStep>) => void;
  onOffsetBlur: () => void;
  onRemove: () => void;
  onPreview: () => void;
}

function Segmented<T extends string>({
  name, value, options, onChange, onBlur, dot,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  onBlur?: () => void;
  dot?: (v: T) => string;
}) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-[12px] border border-line-strong bg-surface-2 p-1">
      {options.map((opt) => (
        <label key={opt.value} className="relative cursor-pointer">
          <input type="radio" name={name} value={opt.value} checked={value === opt.value} onChange={() => onChange(opt.value)} onBlur={onBlur} className="peer sr-only" />
          <span className="flex min-h-11 items-center justify-center gap-1.5 rounded-[9px] px-2 text-center text-[13px] font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:text-ink peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-card peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus sm:min-h-9">
            {dot ? <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", dot(opt.value))} /> : null}
            {opt.label}
          </span>
        </label>
      ))}
    </div>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function StepRow(props: StepRowProps) {
  const { index, kind, draft, open, canBeFinal, lastKey, serverErrors, onToggle, onChange, onOffsetBlur, onRemove, onPreview } = props;
  const offset = parseOffset(draft.offsetText);
  const { when, days } = whenOf(draft.offsetText);
  const preset = isPresetTone(draft.tone);
  const presetCopy = presetText(draft.tone);
  const subject = preset && presetCopy ? presetCopy.subject : draft.subject;
  const body = preset && presetCopy ? presetCopy.body : draft.body;
  const id = `step-${draft.key}`;

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  // The message box grows with its text, so no line is ever cut in half.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body, open, preset]);

  const offsetError = offset === null ? "Enter how many days, using whole numbers." : undefined;
  const finalError = isFinalMisplaced(draft, lastKey)
    ? "A final notice must be the last step. Move this step later, or turn off its final notice."
    : undefined;
  const subjectError = serverErrors.find((e) => /subject/i.test(e));
  const bodyError = serverErrors.find((e) => !/subject/i.test(e) && /body|message|\{|token|field|link|pay/i.test(e));
  const otherErrors = serverErrors.filter((e) => e !== subjectError && e !== bodyError);
  const hasError = Boolean(offsetError || finalError || serverErrors.length > 0);
  const timing = timingText(offset, kind);

  function insert(field: MergeField) {
    const target = field === "pay_link" ? "body" : lastField.current;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const current = target === "subject" ? draft.subject : draft.body;
    const token = `{${field}}`;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange(target === "subject" ? { subject: next } : { body: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <li className={cx("border-b border-line last:border-b-0", open && "bg-surface")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-editor`}
        className={cx(
          "relative flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2/70 sm:px-6",
          STEP_COLUMNS,
          open && "bg-surface-2/60",
          hasError && "shadow-[inset_3px_0_0_var(--color-danger-fill)]",
        )}
      >
        <span aria-hidden="true" className={cx("size-3.5 shrink-0 rounded-full", dotClass(draft.tone, draft.isFinalNotice, draft.requiresApproval))} />
        <span className="num w-10 shrink-0 text-[13px] font-semibold text-ink sm:w-auto">{dayBadge(offset)}</span>
        <span className="min-w-0 flex-1 sm:flex-none">
          <span className="block truncate text-body font-medium text-ink">
            <span className="sr-only">Step {index + 1}: </span>{timing}
          </span>
          <span className="hidden truncate text-small text-ink-3 sm:block">
            <TokenText text={subject} />
          </span>
        </span>
        <span aria-hidden="true" className={cx("ml-auto shrink-0 text-ink-3 transition-transform duration-150 sm:order-last sm:ml-0", open && "rotate-180")}>
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span aria-hidden="true" className="h-0 basis-full sm:hidden" />
        <span className="pl-[calc(0.875rem+0.75rem)] text-small text-ink-2 sm:pl-0 sm:text-body">{TONE_LABEL[draft.tone]}</span>
        <span className="flex flex-wrap gap-1.5 sm:justify-end">
          {hasError ? <Badge tone="danger">Needs a fix</Badge> : null}
          {draft.isFinalNotice ? <Badge tone="danger">Final notice</Badge> : null}
          {draft.requiresApproval ? <Badge tone="warn">Needs approval</Badge> : null}
        </span>
      </button>

      {open ? (
        <div id={`${id}-editor`} role="group" aria-label={`Step ${index + 1}, ${timing}`} className="grid gap-5 border-t border-line px-4 pt-5 pb-5 sm:px-6">
          <div className="grid gap-5 md:grid-cols-2">
            <fieldset className="grid content-start gap-2">
              <legend className="mb-1.5 text-[13px] font-medium text-ink">When it sends</legend>
              <Segmented
                name={`${id}-when`}
                value={when}
                options={WHEN_OPTIONS}
                onChange={(v) => onChange({ offsetText: changeWhen(draft.offsetText, v) })}
                onBlur={onOffsetBlur}
              />
              {when === "on" ? null : (
                <div className="flex items-center gap-2">
                  <label htmlFor={`${id}-days`} className="sr-only">Days</label>
                  <input
                    id={`${id}-days`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={3650}
                    step={1}
                    value={days}
                    aria-invalid={offsetError ? true : undefined}
                    aria-describedby={`${id}-days-text`}
                    onChange={(e) => onChange({ offsetText: joinOffset(when, e.currentTarget.value) })}
                    onBlur={onOffsetBlur}
                    className={cx(FIELD, "num h-11 w-24 sm:h-10")}
                  />
                  <span id={`${id}-days-text`} className="text-body text-ink-2">{when === "before" ? "days before due" : "days after due"}</span>
                </div>
              )}
              {offsetError ? <p role="alert" className="text-small text-danger">{offsetError}</p> : null}
            </fieldset>

            <fieldset className="grid content-start gap-2">
              <legend className="mb-1.5 text-[13px] font-medium text-ink">Tone</legend>
              <Segmented
                name={`${id}-tone`}
                value={draft.tone}
                options={[...PRESET_TONES, "custom" as Tone].map((t) => ({ value: t, label: TONE_LABEL[t] }))}
                dot={(t) => dotClass(t, false, false)}
                onChange={(tone) => {
                  const text = presetText(tone);
                  onChange(text ? { tone, subject: text.subject, body: text.body } : { tone });
                }}
              />
              <p className="text-small text-ink-3">
                {preset ? "Preset wording, written to stay polite. Friendly, neutral and firm escalate in that order." : "Your own wording."}
              </p>
            </fieldset>
          </div>

          {preset ? (
            <div className="grid gap-3 rounded-[var(--radius-md)] border border-line bg-surface-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-small font-medium text-ink-2">
                  <LockIcon />
                  {TONE_LABEL[draft.tone]} preset · read-only
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onChange({ tone: "custom", subject, body })}
                >
                  Switch to custom to edit
                </Button>
              </div>
              <div className="grid gap-1">
                <p className="text-small text-ink-3">Subject</p>
                <p className="text-body font-medium text-ink"><TokenText text={subject} /></p>
              </div>
              <div className="grid gap-1">
                <p className="text-small text-ink-3">Message</p>
                <p className="text-body leading-6 whitespace-pre-wrap text-ink-2"><TokenText text={body} /></p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              <Field id={`${id}-subject`} label="Subject" error={subjectError}>
                <input
                  ref={subjectRef}
                  id={`${id}-subject`}
                  value={subject}
                  maxLength={300}
                  aria-invalid={subjectError ? true : undefined}
                  onFocus={() => { lastField.current = "subject"; }}
                  onChange={(e) => onChange({ subject: e.currentTarget.value })}
                  className={cx(FIELD, "h-11 w-full max-w-2xl")}
                />
              </Field>
              <Field id={`${id}-body`} label="Message" error={bodyError}>
                <textarea
                  ref={bodyRef}
                  id={`${id}-body`}
                  value={body}
                  rows={6}
                  maxLength={10000}
                  aria-invalid={bodyError ? true : undefined}
                  onFocus={() => { lastField.current = "body"; }}
                  onChange={(e) => onChange({ body: e.currentTarget.value })}
                  className={cx(FIELD, "min-h-[9rem] w-full max-w-2xl resize-none overflow-hidden py-2.5 leading-6")}
                />
              </Field>
              <MergeFieldChips onInsert={insert} />
            </div>
          )}

          <div className="grid gap-x-8 rounded-[var(--radius-md)] border border-line px-4 md:grid-cols-2">
            <Switch
              id={`${id}-approval`}
              label="Needs approval"
              checked={draft.requiresApproval}
              description="Waits in Needs you until you approve it."
              onChange={(next) => onChange({ requiresApproval: next, approvalTouched: true })}
            />
            <div className="border-t border-line md:border-t-0">
              <Switch
                id={`${id}-final`}
                label="Final notice"
                checked={draft.isFinalNotice}
                disabled={!canBeFinal && !draft.isFinalNotice}
                description={canBeFinal || draft.isFinalNotice ? "The last reminder. It ends the sequence." : "Only the last step can be the final notice."}
                onChange={(next) => {
                  if (next && !canBeFinal) return;
                  onChange({
                    isFinalNotice: next,
                    requiresApproval: draft.approvalTouched ? draft.requiresApproval : defaultApproval(offset, next),
                  });
                }}
              />
            </div>
          </div>
          {finalError ? <p role="alert" className="-mt-2 text-small text-danger">{finalError}</p> : null}

          {otherErrors.length > 0 ? (
            <ul role="alert" className="grid gap-1 text-small text-danger">
              {otherErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onPreview} className="lg:hidden">Preview this step</Button>
            <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="text-danger hover:text-danger">Delete step</Button>
            <Button type="button" variant="secondary" size="sm" onClick={onToggle} className="ml-auto">Done</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
