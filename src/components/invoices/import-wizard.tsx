"use client";

// The CSV import in three steps: choose a file, check the preview, import. A progress line shows
// where you are. The file goes in through a drop zone (the file input stays in the page, hidden
// but focusable, so keyboard and screen-reader users choose a file the usual way).
import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { commitImportBatchAction, previewImportAction } from "@/app/actions/import";
import { Button, Card, EmptyState, buttonClass, cx } from "@/components/ui";
import { ProgressBar, StatTile, Table, TBody, Td, Th, THead, Tr } from "@/components/data";
import { INVOICE_CSV_HEADERS } from "@/lib/csv";
import { dueDateLabel } from "./format";
import { IDLE_IMPORT_PREVIEW, IMPORT_BATCH_SIZE, IMPORT_MAX_BYTES, type CommitBatchResult, type ImportPreviewState, type RejectedView } from "./import-types";

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

const STEPS = ["Choose a file", "Check the preview", "Import"] as const;

function StepLine({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label="Import steps">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} aria-current={active ? "step" : undefined} className={cx("flex items-center gap-2 sm:gap-3", i < STEPS.length - 1 && "flex-1")}>
            <span
              className={cx(
                "grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
                done && "bg-accent text-accent-ink",
                active && "bg-accent-soft text-accent ring-2 ring-accent",
                !done && !active && "border border-line-strong text-ink-3",
              )}
            >
              {done ? (
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.3 4.9 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              ) : (
                n
              )}
              {done ? <span className="sr-only">Done: </span> : null}
            </span>
            <span className={cx("text-small font-medium whitespace-nowrap", active ? "text-ink" : "text-ink-3", !active && "max-sm:hidden")}>{label}</span>
            {i < STEPS.length - 1 ? <span aria-hidden="true" className={cx("h-px min-w-4 flex-1", done ? "bg-accent" : "bg-line-strong")} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ImportSession({ onStartOver }: { onStartOver: () => void }) {
  const [preview, formAction, uploading] = useActionState(previewImportAction, IDLE_IMPORT_PREVIEW);
  const [commit, setCommit] = useState<CommitState | null>(null);

  const step = commit ? 3 : preview.stage === "preview" ? 2 : 1;
  return (
    <div className="grid gap-6">
      <StepLine current={step} />
      {commit ? (
        <CommitView state={commit} onStartOver={onStartOver} />
      ) : preview.stage === "preview" ? (
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
      ) : (
        <UploadView formAction={formAction} uploading={uploading} serverError={preview.stage === "error" ? preview.message : null} />
      )}
    </div>
  );
}

const COLUMN_RULES: Record<string, { rule: string; example: string }> = {
  client_name: { rule: "The client's name", example: "Acme Ltd" },
  client_email: { rule: "Matches a client, ignoring case. A new client is created when none matches.", example: "accounts@acme.test" },
  invoice_number: { rule: "Unique for the client", example: "INV-1001" },
  amount: { rule: "A point for decimals. Commas between thousands are fine.", example: "1,250.00" },
  currency: { rule: "A three-letter currency code", example: "USD" },
  issue_date: { rule: "YYYY-MM-DD", example: "2026-10-01" },
  due_date: { rule: "YYYY-MM-DD, on or after the issue date", example: "2026-10-15" },
};

// Step 1: the drop zone, then what the file needs.
function UploadView({ formAction, uploading, serverError }: { formAction: (data: FormData) => void; uploading: boolean; serverError: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function accept(f: File | undefined) {
    setFile(f ? { name: f.name, size: f.size } : null);
    if (f && f.size > IMPORT_MAX_BYTES) setLocalError("This file is larger than 2 MB. Split it into smaller files, each under 2 MB, and import each one.");
    else if (f && !/\.csv$/i.test(f.name) && f.type !== "text/csv") setLocalError("Choose a .csv file. Save the spreadsheet as CSV first.");
    else setLocalError(null);
  }

  const error = localError ?? serverError;
  return (
    <div className="grid gap-6">
      <Card as="section" className="p-4 sm:p-6">
        <h2 className="sr-only">Choose a file</h2>
        <form action={formAction} className="grid gap-4" noValidate>
          <label
            htmlFor="import-file"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = e.dataTransfer.files;
              if (input.current && dropped.length > 0) {
                input.current.files = dropped;
                accept(dropped[0]);
              }
            }}
            className={cx(
              "group flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-8 text-center transition-colors",
              "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
              dragging ? "border-accent bg-accent-soft/60" : error ? "border-danger/50 bg-danger-soft/30" : "border-line-strong bg-surface-2/50 hover:border-accent/60 hover:bg-accent-soft/30",
            )}
          >
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-[14px] border border-line bg-surface text-accent shadow-card">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 15V4m0 0L8 8m4-4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            {file ? (
              <span className="grid gap-0.5">
                <span className="text-body font-medium break-all text-ink">{file.name}</span>
                <span className="num text-small text-ink-3">{formatSize(file.size)} · choose another file or drop one here</span>
              </span>
            ) : (
              <span className="grid gap-0.5">
                <span className="text-body font-medium text-ink">
                  Drop your CSV file here, or <span className="text-accent underline underline-offset-4">choose a file</span>
                </span>
                <span className="text-small text-ink-3">Up to 5,000 rows and 2 MB</span>
              </span>
            )}
            <input
              ref={input}
              id="import-file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              aria-describedby={error ? "import-file-error" : undefined}
              onChange={(e) => accept(e.currentTarget.files?.[0])}
              className="sr-only"
            />
          </label>
          {error ? <p id="import-file-error" role="alert" className="text-small text-danger">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={uploading || localError !== null || file === null}>
              {uploading ? "Checking the file…" : "Check the file"}
            </Button>
            <p className="text-small text-ink-3">Nothing is imported until you confirm the preview.</p>
          </div>
        </form>
      </Card>

      <Card as="section" className="overflow-hidden">
        <div className="px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
          <h2 className="text-card-title text-ink">What the file needs</h2>
          <p className="mt-0.5 text-small text-ink-3">A header row with these column names, exactly. Other columns are ignored. Existing invoices are never changed.</p>
        </div>
        <Table label="Required columns">
          <THead>
            <Th>Column</Th>
            <Th>Format</Th>
            <Th>Example</Th>
          </THead>
          <TBody>
            {INVOICE_CSV_HEADERS.map((name) => (
              <Tr key={name}>
                <Td primary>
                  <code className="font-mono text-[13px] font-medium text-ink">{name}</code>
                </Td>
                <Td>{COLUMN_RULES[name]?.rule ?? null}</Td>
                <Td label="e.g.">
                  <span className="num font-mono text-[13px] text-ink-2">{COLUMN_RULES[name]?.example ?? null}</span>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// Step 2: the preview. Counts, a sample of what will import, and every rejected row with its reasons.
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
    <div className="grid gap-6">
      <section aria-labelledby="review-heading" className="grid gap-3">
        <h2 id="review-heading" className="text-section-title text-ink">
          {plural(preview.totalRows, "row", "rows")} checked
        </h2>
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <StatTile label="To import" value={preview.validCount.toLocaleString("en-US")} tone={preview.validCount > 0 ? "ok" : "neutral"} />
          <StatTile label="Rejected" value={preview.rejectedCount.toLocaleString("en-US")} tone={preview.rejectedCount > 0 ? "warn" : "neutral"} />
          <StatTile label="Duplicates" value={preview.duplicates.toLocaleString("en-US")} />
        </div>
      </section>

      {nothingToImport ? (
        <Card>
          <EmptyState
            title="Nothing can be imported from this file"
            body="Every row is rejected. Fix the rows listed below in your file, then upload it again."
            action={<Button type="button" variant="secondary" onClick={onStartOver}>Choose a different file</Button>}
          />
        </Card>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onImport(String(data.get("csvText") ?? ""), Number(data.get("validCount") ?? 0));
          }}
          className="flex flex-wrap items-center gap-2"
        >
          {/* The carried file text. The commit re-reads and re-plans it on the server. */}
          <input type="hidden" name="csvText" value={preview.csvText} />
          <input type="hidden" name="validCount" value={preview.validCount} />
          <Button type="submit" variant="primary">Import {plural(preview.validCount, "invoice", "invoices")}</Button>
          <Button type="button" variant="ghost" onClick={onStartOver}>Choose a different file</Button>
          {preview.rejectedCount > 0 ? <p className="w-full text-small text-ink-3">Rejected rows are skipped. Fix them in the file and import it again later; nothing is imported twice.</p> : null}
        </form>
      )}

      {preview.validSample.length > 0 ? (
        <section aria-labelledby="valid-heading" className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <h3 id="valid-heading" className="text-card-title text-ink">Will import</h3>
            {preview.validSample.length < preview.validCount ? (
              <p className="num text-small text-ink-3">The first {preview.validSample.length} of {preview.validCount.toLocaleString("en-US")}</p>
            ) : null}
          </div>
          <Card className="overflow-hidden">
            <Table label="Rows that will import">
              <THead>
                <Th>Line</Th>
                <Th>Invoice</Th>
                <Th>Client</Th>
                <Th>Due</Th>
                <Th align="right">Amount</Th>
              </THead>
              <TBody>
                {preview.validSample.map((row) => (
                  <Tr key={row.line}>
                    <Td label="Line"><span className="num text-ink-3">{row.line}</span></Td>
                    <Td primary>{row.invoiceNumber}</Td>
                    <Td primary>
                      <span className="block truncate">{row.clientName}</span>
                    </Td>
                    <Td label="Due"><span className="num">{dueDateLabel(row.dueDate)}</span></Td>
                    <Td numeric primary>{row.amount}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Card>
        </section>
      ) : null}

      {preview.rejected.length > 0 ? (
        <section aria-labelledby="rejected-heading" className="grid gap-3">
          <div>
            <h3 id="rejected-heading" className="text-card-title text-ink">Rejected rows ({preview.rejected.length.toLocaleString("en-US")})</h3>
            <p className="mt-0.5 text-small text-ink-3">Values are shown as written in the file, with every reason.</p>
          </div>
          <Card className="overflow-hidden">
            <ol className="divide-y divide-line" aria-label="Rejected rows">
              {shown.map((row) => (
                <RejectedItem key={row.line} row={row} />
              ))}
            </ol>
          </Card>
          {preview.rejected.length > 50 ? (
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${preview.rejected.length.toLocaleString("en-US")} rejected rows`}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
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

// Step 3: progress while the batches run, then the result.
function CommitView({ state, onStartOver }: { state: CommitState; onStartOver: () => void }) {
  return (
    <section aria-labelledby="commit-heading" className="grid gap-6">
      <Card className="grid gap-4 p-4 sm:p-6">
        <div>
          <h2 id="commit-heading" className="text-section-title text-ink">
            {state.status === "running" ? "Importing…" : state.status === "done" ? "Import finished" : "Import stopped"}
          </h2>
          {state.status === "running" ? (
            <p className="mt-0.5 text-small text-ink-3">Keep this page open until it finishes.</p>
          ) : null}
        </div>
        <ProgressBar value={state.processed} max={Math.max(state.total, 1)} label={`${state.processed.toLocaleString("en-US")} of ${state.total.toLocaleString("en-US")} rows`} />
        <p className="sr-only" aria-live="polite">{state.processed} of {state.total} rows processed</p>
        {state.status === "error" && state.message ? (
          <p role="alert" className="rounded-[var(--radius-md)] border border-danger/25 bg-danger-soft px-4 py-3 text-body text-danger">{state.message}</p>
        ) : null}
      </Card>

      {state.status !== "running" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            <StatTile label="Imported" value={state.created.toLocaleString("en-US")} tone={state.created > 0 ? "ok" : "neutral"} />
            <StatTile label="New clients" value={state.clientsCreated.toLocaleString("en-US")} />
            <StatTile label="Duplicates" value={state.duplicates.toLocaleString("en-US")} />
            <StatTile label="Rejected" value={state.rejected.length.toLocaleString("en-US")} tone={state.rejected.length > 0 ? "warn" : "neutral"} />
          </div>
          {state.rejected.length > 0 ? (
            <section aria-labelledby="not-imported-heading" className="grid gap-3">
              <h3 id="not-imported-heading" className="text-card-title text-ink">Rows that were not imported</h3>
              <Card className="overflow-hidden">
                <ol className="divide-y divide-line">
                  {state.rejected.map((r, i) => (
                    <li key={`${r.line}-${i}`} className="grid gap-0.5 px-4 py-3 text-body sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4 sm:px-5">
                      <span className="num font-medium text-ink">Line {r.line}</span>
                      <span className="text-ink-2">{r.reason}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            </section>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link href="/invoices" className={buttonClass("primary")}>View invoices</Link>
            <Button type="button" variant="secondary" onClick={onStartOver}>Import another file</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function RejectedItem({ row }: { row: RejectedView }) {
  const raw = row.raw;
  const summary = [raw.invoice_number, raw.client_name, raw.amount && `${raw.amount} ${raw.currency ?? ""}`.trim()].filter(Boolean).join(" · ");
  return (
    <li className="grid gap-1 px-4 py-3 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4 sm:px-5">
      <span className="num text-body font-medium text-ink">Line {row.line}</span>
      <div className="grid min-w-0 gap-1">
        <p className="truncate font-mono text-[13px] text-ink-3">{summary || "Blank row"}</p>
        <ul className="grid gap-0.5 text-body text-danger">
          {row.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </div>
    </li>
  );
}
