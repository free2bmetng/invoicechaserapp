"use client";

import { Fragment, useActionState, useEffect, useState } from "react";
import { saveSequenceAction, type SequenceEditorData } from "@/app/actions/sequences";
import { Button, Card, Field, TextInput, cx } from "@/components/ui";
import type { PayableChoice, SequenceKind } from "@/lib/queries/sequences";
import { PreviewPanel } from "./preview-panel";
import { StepCard } from "./step-card";
import {
  IDLE_SAVE_RESULT, defaultApproval, isFinalMisplaced, lastKeyOf, newDraft, parseOffset, sendOrder, serializeDrafts, type DraftStep,
} from "./state";

function draftsFrom(data: SequenceEditorData): DraftStep[] {
  return data.steps.map((s, i) => ({
    key: s.id ?? `saved-${i}`,
    id: s.id,
    offsetText: String(s.offsetDays),
    tone: s.tone,
    subject: s.subject,
    body: s.body,
    requiresApproval: s.requiresApproval,
    approvalTouched: true,
    isFinalNotice: s.isFinalNotice,
  }));
}

export function SequenceEditor({
  sequence,
  choices,
  usage,
  stripeConnected,
}: {
  sequence: SequenceEditorData;
  choices: PayableChoice[];
  usage: number;
  stripeConnected: boolean;
}) {
  const kind: SequenceKind = sequence.kind;
  const initialDrafts = draftsFrom(sequence);
  const [name, setName] = useState(sequence.name);
  const [drafts, setDrafts] = useState<DraftStep[]>(initialDrafts);
  const [focusKey, setFocusKey] = useState<string | null>(initialDrafts[0]?.key ?? null);
  // Phone layout: the preview opens under the step being edited, not below every step.
  const [inlinePreviewKey, setInlinePreviewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(() =>
    serializeDrafts({ id: sequence.id, name: sequence.name, kind, isDefault: sequence.isDefault, drafts: initialDrafts }),
  );
  const [result, formAction, pending] = useActionState(saveSequenceAction, IDLE_SAVE_RESULT);

  // After a save, the editor takes the saved steps (with their new ids) and the new baseline.
  // It is derived during render, not in an effect, so a new result object is the only trigger.
  const [seenResult, setSeenResult] = useState(result);
  if (result !== seenResult) {
    setSeenResult(result);
    if (result.ok && result.sequence) {
      const saved = draftsFrom(result.sequence);
      setName(result.sequence.name);
      setDrafts(saved);
      setNotice(null);
      setBaseline(serializeDrafts({ id: sequence.id, name: result.sequence.name, kind, isDefault: sequence.isDefault, drafts: saved }));
    }
  }

  const payload = serializeDrafts({ id: sequence.id, name, kind, isDefault: sequence.isDefault, drafts });
  const dirty = payload !== baseline;

  // Leaving the page with unsaved edits asks the browser to confirm.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const lastKey = lastKeyOf(drafts);
  const ordered = sendOrder(drafts);
  const sendPositionOf = new Map(ordered.map((d, i) => [d.key, i + 1]));
  const focusIndex = drafts.findIndex((d) => d.key === focusKey);
  const focused = focusIndex >= 0 ? drafts[focusIndex] : null;

  const blockers: string[] = [];
  if (name.trim() === "") blockers.push("Give the sequence a name.");
  if (drafts.some((d) => parseOffset(d.offsetText) === null)) blockers.push("Fix the days on each highlighted step.");
  if (drafts.some((d) => isFinalMisplaced(d, lastKey))) blockers.push("A final notice must be the last step.");

  function patchDraft(key: string, patch: Partial<DraftStep>) {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.key !== key) return d;
        const next = { ...d, ...patch };
        if (patch.offsetText !== undefined && !next.approvalTouched) {
          next.requiresApproval = defaultApproval(parseOffset(next.offsetText), next.isFinalNotice);
        }
        return next;
      }),
    );
  }

  function addStep() {
    const offsets = drafts.map((d) => parseOffset(d.offsetText)).filter((n): n is number => n !== null);
    const offset = offsets.length > 0 ? Math.max(...offsets) + 7 : 0;
    const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hadFinal = drafts.some((d) => d.isFinalNotice);
    setDrafts((prev) => [...prev.map((d) => (d.isFinalNotice ? { ...d, isFinalNotice: false } : d)), newDraft(key, offset)]);
    setFocusKey(key);
    setNotice(hadFinal ? "The final notice was turned off, because it must be the last step. Turn it on for the step that should end the sequence." : null);
  }

  function removeStep(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
    if (focusKey === key) setFocusKey(null);
    if (inlinePreviewKey === key) setInlinePreviewKey(null);
  }

  function reorder() {
    setDrafts((prev) => sendOrder(prev));
  }

  // Opens the preview for one step. On a phone it appears under that step and scrolls into view.
  function openPreview(key: string) {
    setFocusKey(key);
    setInlinePreviewKey(key);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      document.getElementById(`preview-${key}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    });
  }

  const formError = result.ok === false ? result.formError : null;
  const savedMessage = result.ok === true && result.message ? result.message : null;
  const statusText = blockers[0] ?? formError ?? (dirty ? "Unsaved changes" : (savedMessage ?? "All changes saved"));
  const statusIsError = Boolean(blockers[0] ?? formError);

  return (
    <form action={formAction} className="grid gap-8" noValidate>
      <input type="hidden" name="payload" value={payload} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="grid min-w-0 gap-6">
          <Card as="section" className="grid gap-5 p-5 sm:p-6">
            <h2 className="text-[16px] font-semibold text-ink">Details</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="sequence-name" label="Name" error={name.trim() === "" ? "Give the sequence a name." : undefined}>
                <TextInput id="sequence-name" value={name} maxLength={120} onChange={(e) => setName(e.currentTarget.value)}
                  aria-invalid={name.trim() === "" ? true : undefined} className="bg-surface border-line-strong" />
              </Field>
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium text-ink">Kind</p>
                <p className="text-[14px] text-ink-2">{kind === "plan" ? "Payment plan installments" : "Standard reminders"}</p>
                <p className="text-[12.5px] leading-5 text-ink-3">The kind is fixed once a sequence is created.</p>
              </div>
            </div>
            <p className="text-[13.5px] leading-6 text-ink-2">
              {kind === "plan"
                ? "Payment plans use the default plan sequence. Each step is relative to its installment's due date."
                : "Each step is relative to the invoice due date. Steps send in order of their offset."}{" "}
              {sequence.isDefault
                ? kind === "plan" ? "This is the default plan sequence." : "This is the default sequence."
                : kind === "plan"
                  ? "Only the default plan sequence is used for payment plans, so this one applies once it is made the default."
                  : "Invoices and clients that do not choose a sequence use the default."}{" "}
              {kind === "plan"
                ? `${usage} payment ${usage === 1 ? "plan uses" : "plans use"} it.`
                : `${usage} open ${usage === 1 ? "invoice uses" : "invoices use"} it.`}
            </p>
          </Card>

          <section aria-labelledby="steps-heading" className="grid gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="steps-heading" className="text-[16px] font-semibold text-ink">Steps</h2>
                <p className="mt-1 text-[13px] leading-5 text-ink-3">
                  Steps send by their day. Equal days send in the order shown. A final notice must be the last step.
                </p>
              </div>
              {drafts.length === 0 ? null : (
                <Button type="button" variant="secondary" size="sm" onClick={addStep} className="min-h-11 sm:min-h-8">Add a step</Button>
              )}
            </div>

            {notice ? <p role="status" className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-3 text-[13px] leading-5 text-ink-2">{notice}</p> : null}

            {drafts.length === 0 ? (
              <div className="grid justify-items-start gap-3 rounded-[var(--radius-lg)] border border-dashed border-line-strong p-6">
                <p className="text-[14px] leading-6 text-ink-2">This sequence has no steps, so nothing is sent for its invoices. Add a step to start.</p>
                <Button type="button" variant="primary" onClick={addStep}>Add a step</Button>
              </div>
            ) : (
              <ol className="grid gap-4" aria-label="Steps in the order listed">
                {drafts.map((draft, index) => (
                  <Fragment key={draft.key}>
                    <StepCard
                      index={index}
                      kind={kind}
                      draft={draft}
                      sendPosition={sendPositionOf.get(draft.key) ?? index + 1}
                      canBeFinal={draft.key === lastKey}
                      lastKey={lastKey}
                      serverErrors={result.ok === false ? (result.stepErrors[String(index)] ?? []) : []}
                      focused={focusKey === draft.key}
                      onFocus={() => setFocusKey(draft.key)}
                      onChange={(patch) => patchDraft(draft.key, patch)}
                      onOffsetBlur={reorder}
                      onRemove={() => removeStep(draft.key)}
                      onPreview={() => openPreview(draft.key)}
                    />
                    {inlinePreviewKey === draft.key ? (
                      <li id={`preview-${draft.key}`} className="scroll-mt-28 lg:hidden">
                        <PreviewPanel
                          kind={kind}
                          choices={choices}
                          focused={draft}
                          position={sendPositionOf.get(draft.key) ?? null}
                          stepNumber={index + 1}
                          stripeConnectedHint={stripeConnected}
                        />
                      </li>
                    ) : null}
                  </Fragment>
                ))}
              </ol>
            )}
          </section>

          <div className={cx("-mx-4 grid gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0 sm:flex sm:items-center sm:justify-between sm:gap-3 sm:rounded-[var(--radius-lg)] sm:border sm:px-5", dirty ? "sticky bottom-0 z-30 shadow-pop" : "relative")}>
            <p role="status" aria-live="polite" className={cx("min-w-0 text-[14px] font-medium", statusIsError ? "text-danger" : dirty ? "text-warn" : "text-ink-2")}>
              {statusText}
            </p>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2 sm:flex sm:shrink-0 sm:items-center">
              {focused ? (
                <Button type="button" variant="secondary" className="min-h-11 w-full lg:hidden" onClick={() => openPreview(focused.key)}>
                  Open preview
                </Button>
              ) : null}
              <Button type="submit" variant="primary" className="min-h-11 w-full sm:min-h-10 sm:w-auto" disabled={pending || blockers.length > 0 || !dirty}>
                {pending ? "Saving…" : "Save sequence"}
              </Button>
            </div>
          </div>
        </div>

        <aside className="hidden min-w-0 lg:sticky lg:top-6 lg:grid lg:gap-4">
          <PreviewPanel
            kind={kind}
            choices={choices}
            focused={focused}
            position={focused ? (sendPositionOf.get(focused.key) ?? null) : null}
            stepNumber={focused ? focusIndex + 1 : null}
            stripeConnectedHint={stripeConnected}
          />
        </aside>
      </div>
    </form>
  );
}
