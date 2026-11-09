"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { commitImportBatchAction, previewImportAction } from "@/app/actions/import";
import { Button, Card, EmptyState, cx } from "@/components/ui";
import { IDLE_IMPORT_PREVIEW, IMPORT_BATCH_SIZE, IMPORT_MAX_BYTES, type CommitBatchResult, type ImportPreviewState, type RejectedView, type ValidView } from "./import-types";

// The whole import lives in one session component. "Start over" remounts it, which clears the file.
export function ImportWizard() {
  const [session, setSession] = useState(0);
  return <ImportSession key={session} onStartOver={() => setSession((n) => n + 1)} />;
}

interface CommitState {
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  created: number;
  duplicates: number;
  clientsCreated: number;
  rejected: { line: number; reason: string }[];
  message: string | null;
}

function ImportSession({ onStartOver }: { onStartOver: () => void }) {
  const [preview, formAction, uploading] = useActionState(previewImportAction, IDLE_IMPORT_PREVIEW);
  const [commit, setCommit] = useState<CommitState | null>(null);
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  function checkFile(file: File | undefined) {
    if (file && file.size > IMPORT_MAX_BYTES) {
      setTooLarge("This file is larger than 2 MB. Split it into smaller files, each under 2 MB, and import each one.");
    } else {
      setTooLarge(null);
    }
  }

  if (commit) return <CommitView state={commit} onStartOver={onStartOver} />;

  if (preview.stage === "preview") {
    return (
      <ReviewView
        preview={preview}
        onStartOver={onStartOver}
        onImport={(csvText, total) => {
          // Rows rejected at preview were never imported, so they count toward the summary from the start.
          const base = {
            duplicates: preview.duplicates,
            rejected: preview.rejected.map((r) => ({ line: r.line, reason: r.reasons.join(" ") })),
          };
          setCommit({ status: "running", processed: 0, total, created: 0, duplicates: base.duplicates, clientsCreated: 0, rejected: base.rejected, message: null });
          void runCommit(csvText, total, base, setCommit);
        }}
      />
    );
  }

  const error = tooLarge ?? (preview.stage === "error" ? preview.message : null);
  return (
    <section aria-labelledby="upload-heading" className="grid gap-5">
      <div>
        <h2 id="upload-heading" className="text-[16px] font-semibold text-ink">1. Upload your file</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">Up to 5,000 rows and 2 MB. Nothing is imported until you confirm the preview.</p>
      </div>
      <form action={formAction} className="grid gap-4" noValidate>
        <div className="grid gap-2">
          <p id="import-file-label" className="text-[13px] font-medium text-ink">CSV file</p>
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="import-file"
              className="inline-flex h-11 cursor-pointer items-center justify-center rounded-[10px] border border-line-strong bg-surface px-4 text-sm font-medium text-ink shadow-card transition-colors duration-150 hover:border-ink-3 hover:bg-surface-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)] sm:h-10"
            >
              Choose file
              <input
                id="import-file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                aria-describedby="import-file-status"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  setFileName(file ? file.name : null);
                  checkFile(file);
                }}
                className="sr-only"
              />
            </label>
            <span id="import-file-status" className="text-[13px] text-ink-3">{fileName ?? "No file chosen"}</span>
          </div>
          {error ? <p role="alert" className="text-[12.5px] leading-5 text-danger">{error}</p> : null}
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={uploading || tooLarge !== null || fileName === null}>
            {uploading ? "Checking the file…" : "Preview import"}
          </Button>
          {fileName === null ? <p className="mt-2 text-[13px] text-ink-3">Choose a CSV file to turn on the preview.</p> : null}
        </div>
      </form>
    </section>
  );
}

// Step 2: the preview. Counts, every rejected row with its reasons, and a sample of what will import.
function ReviewView({
  preview,
  onStartOver,
  onImport,
}: {
  preview: Extract<ImportPreviewState, { stage: "preview" }>;
  onStartOver: () => void;
  onImport: (csvText: string, total: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? preview.rejected : preview.rejected.slice(0, 50);
  const nothingToImport = preview.validCount === 0;

  return (
    <section aria-labelledby="review-heading" className="grid gap-6">
      <div>
        <h2 id="review-heading" className="text-[16px] font-semibold text-ink">2. Check the preview</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">
          {preview.totalRows} {preview.totalRows === 1 ? "row" : "rows"} in the file. Rows that are rejected are not imported, and no existing invoice is ever overwritten.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Will import" value={preview.validCount} tone="ok" />
        <Stat label="Rejected" value={preview.rejectedCount} tone={preview.rejectedCount > 0 ? "warn" : "neutral"} />
        <Stat label="Duplicates" value={preview.duplicates} tone="neutral" hint="Already imported" />
      </dl>

      {nothingToImport ? (
        <EmptyState
          title="Nothing can be imported from this file"
          body="Every row is rejected, so there is nothing to import. Fix the rows listed below in your file, then upload it again."
          action={<Button type="button" variant="secondary" onClick={onStartOver}>Choose a different file</Button>}
        />
      ) : null}

      {preview.validSample.length > 0 ? (
        <Card as="section" className="grid gap-3 p-5">
          <h3 className="text-[14px] font-semibold text-ink">Will import (first {preview.validSample.length} of {preview.validCount})</h3>
          <ul className="grid gap-2" aria-label="Rows that will import">
            {preview.validSample.map((row) => (
              <ValidItem key={row.line} row={row} />
            ))}
          </ul>
        </Card>
      ) : null}

      {preview.rejected.length > 0 ? (
        <Card as="section" className="grid gap-3 p-5">
          <h3 className="text-[14px] font-semibold text-ink">Rejected rows ({preview.rejected.length})</h3>
          <p className="text-[13px] leading-5 text-ink-3">Every reason is listed. Fix the row in your file and upload again to import it.</p>
          <ol className="grid gap-2" aria-label="Rejected rows">
            {shown.map((row) => (
              <RejectedItem key={row.line} row={row} />
            ))}
          </ol>
          {preview.rejected.length > 50 ? (
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${preview.rejected.length} rejected rows`}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onImport(String(data.get("csvText") ?? ""), Number(data.get("validCount") ?? 0));
        }}
        className="flex flex-wrap items-center gap-3"
      >
        {/* The carried file text. The commit re-reads and re-plans it on the server. */}
        <input type="hidden" name="csvText" value={preview.csvText} />
        <input type="hidden" name="validCount" value={preview.validCount} />
        <Button type="submit" variant="primary" disabled={nothingToImport}>
          Import {preview.validCount} {preview.validCount === 1 ? "invoice" : "invoices"}
        </Button>
        <Button type="button" variant="ghost" onClick={onStartOver}>Choose a different file</Button>
      </form>
    </section>
  );
}

async function runCommit(
  csvText: string,
  total: number,
  base: { duplicates: number; rejected: { line: number; reason: string }[] },
  setCommit: (updater: (prev: CommitState | null) => CommitState | null) => void,
) {
  let afterLine = 0;
  let processed = 0;
  let created = 0;
  let duplicates = base.duplicates;
  let clientsCreated = 0;
  const rejected: { line: number; reason: string }[] = [...base.rejected];
  const maxCalls = Math.ceil(total / IMPORT_BATCH_SIZE) + 2;

  for (let call = 0; call < maxCalls; call++) {
    let result: CommitBatchResult;
    try {
      result = await commitImportBatchAction(csvText, afterLine);
    } catch {
      result = { ok: false, message: "The connection was interrupted. Some rows may already be imported. Check the invoice list before importing again." };
    }
    if (!result.ok) {
      setCommit((prev) => (prev ? { ...prev, status: "error", message: result.message, created, duplicates, clientsCreated, rejected: [...rejected], processed } : prev));
      return;
    }
    created += result.created;
    duplicates += result.duplicates;
    clientsCreated += result.clientsCreated;
    rejected.push(...result.rejected);
    processed += result.batchSize;
    setCommit((prev) => (prev ? { ...prev, processed, created, duplicates, clientsCreated, rejected: [...rejected] } : prev));
    if (!result.hasMore) break;
    afterLine = result.lastLine;
  }
  setCommit((prev) => (prev ? { ...prev, status: "done", processed, created, duplicates, clientsCreated, rejected: [...rejected] } : prev));
}

// Step 3: progress while the batches run, then the result summary.
function CommitView({ state, onStartOver }: { state: CommitState; onStartOver: () => void }) {
  const percent = state.total === 0 ? 100 : Math.min(100, Math.round((state.processed / state.total) * 100));
  const batches = Math.ceil(state.total / IMPORT_BATCH_SIZE);
  return (
    <section aria-labelledby="commit-heading" className="grid gap-6">
      <div>
        <h2 id="commit-heading" className="text-[16px] font-semibold text-ink">3. {state.status === "running" ? "Importing" : state.status === "done" ? "Import finished" : "Import stopped"}</h2>
        {state.status === "running" ? (
          <p className="mt-1 text-[13px] leading-5 text-ink-3">
            Importing in batches of {IMPORT_BATCH_SIZE}, {batches} at most. Keep this page open until it finishes.
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.processed}
          className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
        <p className="num text-[13px] text-ink-2" aria-live="polite">{state.processed} of {state.total} rows processed</p>
      </div>

      {state.status === "error" && state.message ? (
        <p role="alert" className="rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] leading-6 text-danger">{state.message}</p>
      ) : null}

      {state.status !== "running" ? (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Created" value={state.created} tone="ok" />
            <Stat label="Duplicates" value={state.duplicates} tone="neutral" hint="Not imported" />
            <Stat label="New clients" value={state.clientsCreated} tone="neutral" />
            <Stat label="Rejected" value={state.rejected.length} tone={state.rejected.length > 0 ? "warn" : "neutral"} />
          </dl>
          {state.rejected.length > 0 ? (
            <Card as="section" className="grid gap-3 p-5">
              <h3 className="text-[14px] font-semibold text-ink">Rows that could not be imported</h3>
              <ol className="grid gap-2">
                {state.rejected.map((r, i) => (
                  <li key={`${r.line}-${i}`} className="grid gap-0.5 rounded-[var(--radius-md)] border border-line px-3 py-2.5 text-[13px] leading-5">
                    <span className="num font-medium text-ink">Line {r.line}</span>
                    <span className="text-ink-2">{r.reason}</span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Link href="/invoices" className="inline-flex h-10 items-center justify-center rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover">
              View invoices
            </Link>
            <Button type="button" variant="secondary" onClick={onStartOver}>Import another file</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: number; tone: "ok" | "warn" | "neutral"; hint?: string }) {
  return (
    <div className="grid gap-1 rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-3 shadow-card">
      <dt className="text-[12.5px] font-medium text-ink-3">{label}</dt>
      <dd className={cx("num text-[24px] font-semibold tracking-[-0.02em]", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "neutral" && "text-ink")}>
        {value}
      </dd>
      {hint ? <p className="text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

function ValidItem({ row }: { row: ValidView }) {
  return (
    <li className="grid gap-0.5 rounded-[var(--radius-md)] border border-line px-3 py-2.5 text-[13px] leading-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <span className="min-w-0 truncate text-ink">
        <span className="font-medium">{row.invoiceNumber}</span> · {row.clientName} · <span className="text-ink-3">{row.clientEmail}</span>
      </span>
      <span className="num text-ink-2 sm:text-right">{row.amount} · due {row.dueDate}</span>
    </li>
  );
}

function RejectedItem({ row }: { row: RejectedView }) {
  const raw = row.raw;
  return (
    <li className="grid gap-1.5 rounded-[var(--radius-md)] border border-danger/20 bg-surface px-3 py-2.5 text-[13px] leading-5">
      <p className="font-medium text-ink">
        <span className="num">Line {row.line}</span>
        <span className="font-normal text-ink-3">
          {" · "}
          {[raw.invoice_number, raw.client_name, raw.amount && `${raw.amount} ${raw.currency ?? ""}`.trim()].filter(Boolean).join(" · ") || "(blank row)"}
        </span>
      </p>
      <ul className="grid gap-0.5 text-danger">
        {row.reasons.map((reason, i) => (
          <li key={i}>{reason}</li>
        ))}
      </ul>
    </li>
  );
}
