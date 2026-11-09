// One step of the sequence editor. Controlled by the editor: it renders the step and reports changes.
// Each error sits beside the field it concerns; anything else is listed at the foot of the step.
import { Button, Field, Select, Switch, TextInput, Textarea, cx } from "@/components/ui";
import type { Tone } from "@/lib/types";
import type { SequenceKind } from "@/lib/queries/sequences";
import {
  PRESET_TONES, TONE_LABEL, changeWhen, daysSummary, defaultApproval, isFinalMisplaced, isPresetTone, joinOffset, ordinal, parseOffset,
  presetText, whenOf, type DraftStep, type When,
} from "./state";

const WHEN_OPTIONS: { value: When; label: string }[] = [
  { value: "before", label: "Before due" },
  { value: "on", label: "On due date" },
  { value: "after", label: "After due" },
];

// Editable fields are surface-coloured with a line-strong border. Preset wording is read-only:
// it keeps the surface colour and a plain border, so it never looks like it can be typed into.
const EDITABLE = "bg-surface border-line-strong";
const READ_ONLY = "bg-surface border-line text-ink-2 cursor-default";

export interface StepCardProps {
  index: number;
  kind: SequenceKind;
  draft: DraftStep;
  sendPosition: number;
  canBeFinal: boolean;
  lastKey: string | null;
  serverErrors: string[];
  focused: boolean;
  onFocus: () => void;
  onChange: (patch: Partial<DraftStep>) => void;
  onOffsetBlur: () => void;
  onRemove: () => void;
  onPreview: () => void;
}

export function StepCard(props: StepCardProps) {
  const { index, kind, draft, sendPosition, canBeFinal, lastKey, serverErrors, focused, onFocus, onChange, onOffsetBlur, onRemove, onPreview } = props;
  const offset = parseOffset(draft.offsetText);
  const { when, days } = whenOf(draft.offsetText);
  const preset = isPresetTone(draft.tone);
  const presetCopy = presetText(draft.tone);
  const subject = preset && presetCopy ? presetCopy.subject : draft.subject;
  const body = preset && presetCopy ? presetCopy.body : draft.body;
  const id = `step-${draft.key}`;

  const offsetError = offset === null ? "Enter how many days, using whole numbers." : undefined;
  const finalError = isFinalMisplaced(draft, lastKey)
    ? "A final notice must be the last step. Move this step later, or turn off its final notice."
    : undefined;
  const subjectError = serverErrors.find((e) => /subject/i.test(e));
  const bodyError = serverErrors.find((e) => !/subject/i.test(e) && /body|message|\{|token|field|link|pay/i.test(e));
  const otherErrors = serverErrors.filter((e) => e !== subjectError && e !== bodyError);
  const hasError = Boolean(offsetError || finalError || serverErrors.length > 0);

  return (
    <li
      onFocusCapture={onFocus}
      className={cx(
        "grid gap-4 rounded-[var(--radius-lg)] border bg-surface p-4 shadow-card sm:p-5",
        focused ? "border-accent/50" : "border-line",
        hasError && "border-danger/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[15px] font-semibold text-ink">Step {index + 1}</p>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">
            Sends {ordinal(sendPosition)}
          </span>
          {draft.isFinalNotice ? (
            <span className="rounded-full border border-warn/25 bg-warn-soft px-2 py-0.5 text-[12px] font-medium text-warn">Final notice</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onPreview} aria-label={`Preview step ${index + 1}`} className="min-h-11 sm:min-h-8">Preview</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Delete step ${index + 1}`} className="min-h-11 sm:min-h-8">Delete</Button>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-[13px] font-medium text-ink">When it sends</legend>
        <div className="grid grid-cols-3 gap-1 rounded-[12px] border border-line-strong bg-surface p-1">
          {WHEN_OPTIONS.map((opt) => (
            <label key={opt.value} className="relative cursor-pointer">
              <input
                type="radio"
                name={`${id}-when`}
                value={opt.value}
                checked={when === opt.value}
                onChange={() => onChange({ offsetText: changeWhen(draft.offsetText, opt.value) })}
                onBlur={onOffsetBlur}
                className="peer sr-only"
              />
              <span className="flex min-h-11 items-center justify-center rounded-[9px] px-2 text-center text-[13.5px] font-medium text-ink-2 transition-colors duration-150 hover:text-ink peer-checked:bg-accent peer-checked:text-accent-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)] sm:min-h-9">
                {opt.label}
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {when === "on" ? null : (
            <Field id={`${id}-days`} label="Days" error={offsetError}>
              <TextInput
                id={`${id}-days`}
                type="number"
                inputMode="numeric"
                min={0}
                max={3650}
                step={1}
                value={days}
                aria-invalid={offsetError ? true : undefined}
                onChange={(e) => onChange({ offsetText: joinOffset(when, e.currentTarget.value) })}
                onBlur={onOffsetBlur}
                className={cx("num w-28", EDITABLE)}
              />
            </Field>
          )}
          <p className="pb-2.5 text-[15px] font-medium text-ink">{daysSummary(draft.offsetText, kind)}</p>
        </div>
      </fieldset>

      <Field id={`${id}-tone`} label="Tone" hint={preset ? "Preset wording. Choose Custom to edit it." : "Custom wording that you wrote."}>
        <Select id={`${id}-tone`} value={draft.tone} className={EDITABLE}
          onChange={(e) => {
            const tone = e.currentTarget.value as Tone;
            const text = presetText(tone);
            onChange(text ? { tone, subject: text.subject, body: text.body } : { tone });
          }}>
          {[...PRESET_TONES, "custom" as Tone].map((t) => (
            <option key={t} value={t}>{TONE_LABEL[t]}</option>
          ))}
        </Select>
      </Field>

      <Field id={`${id}-subject`} label="Subject" error={subjectError}>
        <TextInput id={`${id}-subject`} value={subject} readOnly={preset} maxLength={300} aria-invalid={subjectError ? true : undefined}
          onChange={(e) => onChange({ subject: e.currentTarget.value })} className={preset ? READ_ONLY : EDITABLE} />
      </Field>
      <Field
        id={`${id}-body`}
        label="Message"
        hint="Merge fields: {client_name} {invoice_number} {amount} {currency} {due_date} {days_overdue} {pay_link} {sender_name} {business_name}."
        error={bodyError}
      >
        <Textarea id={`${id}-body`} value={body} readOnly={preset} rows={8} maxLength={10000} aria-invalid={bodyError ? true : undefined}
          onChange={(e) => onChange({ body: e.currentTarget.value })} className={cx("font-sans", preset ? READ_ONLY : EDITABLE)} />
      </Field>

      <div className="grid gap-1 divide-y divide-line">
        <Switch
          id={`${id}-approval`}
          label="Requires approval"
          checked={draft.requiresApproval}
          description="Waits in Needs you until you approve it. On by default for offsets above 14 days and for final notices."
          onChange={(next) => onChange({ requiresApproval: next, approvalTouched: true })}
        />
        <div>
          <Switch
            id={`${id}-final`}
            label="Final notice"
            checked={draft.isFinalNotice}
            description={canBeFinal || draft.isFinalNotice
              ? "The last reminder for the invoice. It must be the last step in send order."
              : "Only the last step in send order can be the final notice."}
            onChange={(next) => {
              // Only the last step in send order may become the final notice.
              if (next && !canBeFinal) return;
              onChange({
                isFinalNotice: next,
                requiresApproval: draft.approvalTouched ? draft.requiresApproval : defaultApproval(offset, next),
              });
            }}
          />
          {finalError ? <p role="alert" className="pb-3 text-[13px] leading-5 text-danger">{finalError}</p> : null}
        </div>
      </div>

      {otherErrors.length > 0 ? (
        <ul role="alert" className="grid gap-1 text-[13px] leading-5 text-danger">
          {otherErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
