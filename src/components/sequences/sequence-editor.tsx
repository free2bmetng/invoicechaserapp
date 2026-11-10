"use client";

import { Fragment, useActionState, useEffect, useState } from "react";
import { saveSequenceAction, type SequenceEditorData } from "@/app/actions/sequences";
import { Button, Card, cx } from "@/components/ui";
import type { PayableChoice, SequenceKind } from "@/lib/queries/sequences";
import { PreviewPanel } from "./preview-panel";
import { StepRow, STEP_COLUMNS } from "./step-row";
import {
  IDLE_SAVE_RESULT, defaultApproval, isFinalMisplaced, lastKeyOf, newDraft, parseOffset, phaseLabel, phaseOf, sendOrder,
  serializeDrafts, type DraftStep,
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

// The sequence editor: the steps as a table of day offsets grouped "Before due" and "Overdue",
// one step open at a time, and the open step's email preview beside it (under the step on a phone).
export function SequenceEditor({
  sequence,
  choices,
  stripeConnected,
  fromAddress,
  windowText,
}: {
  sequence: SequenceEditorData;
  choices: PayableChoice[];
  stripeConnected: boolean;
  fromAddress: string | null;
  windowText: string;
}) {
  const kind: SequenceKind = sequence.kind;
  const initialDrafts = sendOrder(draftsFrom(sequence));
  const [name, setName] = useState(sequence.name);
  const [drafts, setDrafts] = useState<DraftStep[]>(initialDrafts);
  // One step open at a time. The preview follows the open step, or the last one opened.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(initialDrafts[0]?.key ?? null);
  // Phone layout: the preview opens under the step being edited, not below every step.
  const [inlinePreviewKey, setInlinePreviewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(() =>
    serializeDrafts({ id: sequence.id, name: sequence.name, kind, isDefault: sequence.isDefault, drafts: initialDrafts }),
  );
  const [result, formAction, pending] = useActionState(saveSequenceAction, IDLE_SAVE_RESULT);

  // After a save, the editor takes the saved steps (with their new ids) and the new baseline. A failed
  // save opens the first step with an error. Derived during render, so a new result is the only trigger.
  const [seenResult, setSeenResult] = useState(result);
  if (result !== seenResult) {
    setSeenResult(result);
    if (result.ok && result.sequence) {
      const saved = sendOrder(draftsFrom(result.sequence));
      setName(result.sequence.name);
      setDrafts(saved);
      setNotice(null);
      setOpenKey(null);
      setInlinePreviewKey(null);
      setFocusKey((k) => (saved.some((d) => d.key === k) ? k : (saved[0]?.key ?? null)));
      setBaseline(serializeDrafts({ id: sequence.id, name: result.sequence.name, kind, isDefault: sequence.isDefault, drafts: saved }));
    } else if (result.ok === false) {
      const first = Object.keys(result.stepErrors).map(Number).sort((a, b) => a - b)[0];
      if (first !== undefined && drafts[first]) {
        setOpenKey(drafts[first].key);
        setFocusKey(drafts[first].key);
      }
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
  const focusIndex = drafts.findIndex((d) => d.key === focusKey);
  const focused = focusIndex >= 0 ? drafts[focusIndex] : null;

  const blockers: string[] = [];
  if (name.trim() === "") blockers.push("Give the sequence a name.");
  if (drafts.some((d) => parseOffset(d.offsetText) === null)) blockers.push("Fix the days on the highlighted step.");
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

  function toggle(key: string) {
    setOpenKey((k) => (k === key ? null : key));
    setFocusKey(key);
    if (inlinePreviewKey !== key) setInlinePreviewKey(null);
  }

  function addStep() {
    const offsets = drafts.map((d) => parseOffset(d.offsetText)).filter((n): n is number => n !== null);
    const offset = offsets.length > 0 ? Math.max(...offsets) + 7 : 0;
    const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hadFinal = drafts.some((d) => d.isFinalNotice);
    setDrafts((prev) => [...prev.map((d) => (d.isFinalNotice ? { ...d, isFinalNotice: false } : d)), newDraft(key, offset)]);
    setOpenKey(key);
    setFocusKey(key);
    setInlinePreviewKey(null);
    setNotice(hadFinal ? "The final notice was turned off, because it must be the last step. Turn it on for the step that should end the sequence." : null);
  }

  function removeStep(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
    if (openKey === key) setOpenKey(null);
    if (focusKey === key) setFocusKey(null);
    if (inlinePreviewKey === key) setInlinePreviewKey(null);
  }

  // Rows keep their place while the days are typed, and settle into send order when the field is left.
  function reorder() {
    setDrafts((prev) => sendOrder(prev));
  }

  // Opens the preview for one step. On a phone it appears under that step and scrolls into view.
  function openPreview(key: string) {
    setFocusKey(key);
    setInlinePreviewKey(key);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      document.getElementById(`preview-${key}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });
  }

  const formError = result.ok === false ? result.formError : null;
  const savedMessage = result.ok === true && result.message ? result.message : null;
  const statusText = blockers[0] ?? formError ?? (dirty ? "Unsaved changes" : (savedMessage ?? "All changes saved"));
  const statusIsError = Boolean(blockers[0] ?? formError);
  const approvals = drafts.filter((d) => d.requiresApproval).length;

  const preview = (
    <PreviewPanel
      kind={kind}
      choices={choices}
      focused={focused}
      stepNumber={focused ? focusIndex + 1 : null}
      stripeConnectedHint={stripeConnected}
      fromAddress={fromAddress}
    />
  );

  return (
    <form action={formAction} className="grid gap-6" noValidate>
      <input type="hidden" name="payload" value={payload} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="grid min-w-0 gap-6">
          <Card className="grid gap-1.5 px-4 py-4 sm:px-6">
            <label htmlFor="sequence-name" className="text-[13px] font-medium text-ink">Name</label>
            <input
              id="sequence-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.currentTarget.value)}
              aria-invalid={name.trim() === "" ? true : undefined}
              aria-describedby="sequence-name-note"
              className="h-11 w-full max-w-md rounded-[10px] border border-line-strong bg-surface px-3 text-[14px] text-ink hover:border-control-border focus:border-accent aria-[invalid=true]:border-danger"
            />
            <p id="sequence-name-note" className={cx("text-small", name.trim() === "" ? "text-danger" : "text-ink-3")}>
              {name.trim() === "" ? "Give the sequence a name." : `${kind === "plan" ? "Payment plan" : "Reminder"} sequence. ${windowText}`}
            </p>
          </Card>

          <Card className="overflow-hidden" as="section">
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
              <div className="min-w-0">
                <h2 id="steps-heading" className="text-card-title text-ink">Steps</h2>
                <p className="mt-0.5 text-small text-ink-3">
                  {drafts.length} {drafts.length === 1 ? "step" : "steps"}
                  {approvals > 0 ? ` · ${approvals} ${approvals === 1 ? "waits" : "wait"} for your approval` : ""}
                  {" · "}Select a step to edit it.
                </p>
              </div>
              {drafts.length === 0 ? null : (
                <Button type="button" size="sm" onClick={addStep} className="-my-1.5">Add step</Button>
              )}
            </div>

            {notice ? <p role="status" className="mx-4 mb-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-3 text-small text-ink-2 sm:mx-6">{notice}</p> : null}

            {drafts.length === 0 ? (
              <div className="grid justify-items-start gap-3 border-t border-line px-4 py-6 sm:px-6">
                <p className="text-body text-ink-2">This sequence has no steps, so nothing is sent for its invoices. Add a step to start.</p>
                <Button type="button" variant="primary" onClick={addStep}>Add a step</Button>
              </div>
            ) : (
              <>
                <div aria-hidden="true" className={cx("hidden border-t border-line px-6 py-2 text-[12.5px] font-medium text-ink-3", STEP_COLUMNS)}>
                  <span />
                  <span>Day</span>
                  <span>Sends, and the subject</span>
                  <span>Tone</span>
                  <span />
                  <span />
                </div>
                <ol aria-labelledby="steps-heading">
                  {drafts.map((draft, index) => {
                    const phase = phaseOf(parseOffset(draft.offsetText));
                    const prevPhase = index > 0 ? phaseOf(parseOffset(drafts[index - 1].offsetText)) : null;
                    return (
                      <Fragment key={draft.key}>
                        {phase !== prevPhase ? (
                          <li aria-hidden="true" className="flex items-center gap-2 border-y border-line bg-surface-2 px-4 py-1.5 text-[12.5px] font-semibold text-ink-2 sm:px-6">
                            {phaseLabel(phase, kind)}
                          </li>
                        ) : null}
                        <StepRow
                          index={index}
                          kind={kind}
                          draft={draft}
                          open={openKey === draft.key}
                          canBeFinal={draft.key === lastKey}
                          lastKey={lastKey}
                          serverErrors={result.ok === false ? (result.stepErrors[String(index)] ?? []) : []}
                          onToggle={() => toggle(draft.key)}
                          onChange={(patch) => patchDraft(draft.key, patch)}
                          onOffsetBlur={reorder}
                          onRemove={() => removeStep(draft.key)}
                          onPreview={() => openPreview(draft.key)}
                        />
                        {inlinePreviewKey === draft.key && openKey === draft.key ? (
                          <li id={`preview-${draft.key}`} className="scroll-mt-20 border-b border-line bg-surface-2/60 px-4 py-4 lg:hidden">
                            {preview}
                          </li>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </ol>
              </>
            )}
          </Card>

          <div className={cx("-mx-4 grid gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0 sm:flex sm:items-center sm:justify-between sm:gap-3 sm:rounded-[var(--radius-lg)] sm:border sm:px-5", dirty ? "sticky bottom-0 z-30 shadow-pop" : "relative")}>
            <p role="status" aria-live="polite" className={cx("min-w-0 text-body font-medium", statusIsError ? "text-danger" : dirty ? "text-warn" : "text-ink-2")}>
              {statusText}
            </p>
            <Button type="submit" variant="primary" className="w-full sm:w-auto" disabled={pending || blockers.length > 0 || !dirty}>
              {pending ? "Saving…" : "Save sequence"}
            </Button>
          </div>
        </div>

        <aside className="hidden min-w-0 lg:sticky lg:top-6 lg:grid">
          {focused ? preview : (
            <div className="grid gap-2 rounded-[var(--radius-lg)] border border-dashed border-line-strong p-5">
              <p className="text-card-title text-ink">Preview</p>
              <p className="text-body text-ink-2">Add a step to see the email it sends.</p>
            </div>
          )}
          {sequence.isDefault ? null : (
            <p className="mt-3 text-small text-ink-3">
              {kind === "plan" ? "Only the default plan sequence is used for payment plans." : "Invoices and clients that choose no sequence use the default."}
            </p>
          )}
        </aside>
      </div>
    </form>
  );
}
