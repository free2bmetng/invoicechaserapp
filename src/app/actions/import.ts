"use server";

// CSV import: a preview that validates the file, and a commit that imports one batch per call.
// The commit never trusts rows sent by the client. It re-reads the carried file text and plans it
// again on the server, so the rows it imports are the ones the server validated.
import { revalidatePath } from "next/cache";
import { systemClock } from "@/lib/clock";
import { MAX_IMPORT_ROWS, planCsvImport } from "@/lib/csv";
import { importInvoices } from "@/lib/engine";
import { formatMoney } from "@/lib/money";
import { describeEngineError, existingInvoiceKeys, loadWorkspace } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";
import { todayIn } from "@/components/invoices/format";
import {
  IMPORT_BATCH_SIZE, IMPORT_MAX_BYTES, type CommitBatchResult, type ImportPreviewState,
} from "@/components/invoices/import-types";

const TOO_LARGE = "This file is larger than 2 MB. Split it into smaller files, each under 2 MB, and import each one.";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function previewImportAction(_previous: ImportPreviewState, formData: FormData): Promise<ImportPreviewState> {
  const userId = await requireUserId();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { stage: "error", message: "Choose a CSV file to upload." };
  }
  // Check the size before reading, so an oversized upload is never loaded into memory.
  if (file.size > IMPORT_MAX_BYTES) return { stage: "error", message: TOO_LARGE };

  const text = await file.text();
  if (byteLength(text) > IMPORT_MAX_BYTES) return { stage: "error", message: TOO_LARGE };

  const workspace = await loadWorkspace(userId);
  const plan = planCsvImport(text, await existingInvoiceKeys(userId), todayIn(workspace.zone));
  if (plan.headerErrors.length > 0) {
    return { stage: "error", message: plan.headerErrors.join(" ") };
  }

  const totalRows = plan.valid.length + plan.rejected.length;
  return {
    stage: "preview",
    message: null,
    csvText: text,
    totalRows,
    validCount: plan.valid.length,
    rejectedCount: plan.rejected.length,
    duplicates: plan.duplicates,
    rejected: plan.rejected.map((r) => ({ line: r.line, reasons: r.reasons, raw: { ...r.raw } })),
    validSample: plan.valid.slice(0, 10).map((v) => ({
      line: v.line,
      clientName: v.clientName,
      clientEmail: v.clientEmail,
      invoiceNumber: v.invoiceNumber,
      amount: formatMoney(v.amountMinor, v.currency),
      currency: v.currency,
      issueDate: v.issueDate,
      dueDate: v.dueDate,
    })),
  };
}

// Imports the next batch of up to 500 valid rows after the cursor. The client calls this in a loop
// until hasMore is false. Rows already imported are duplicates in the next plan, so they drop out.
export async function commitImportBatchAction(csvText: string, afterLine: number): Promise<CommitBatchResult> {
  const userId = await requireUserId();
  if (typeof csvText !== "string" || csvText.length === 0) {
    return { ok: false, message: "The file is missing. Upload it again." };
  }
  if (byteLength(csvText) > IMPORT_MAX_BYTES) return { ok: false, message: TOO_LARGE };
  if (!Number.isInteger(afterLine) || afterLine < 0) return { ok: false, message: "The import position is not valid. Start the import again." };

  const workspace = await loadWorkspace(userId);
  const plan = planCsvImport(csvText, await existingInvoiceKeys(userId), todayIn(workspace.zone));
  if (plan.headerErrors.length > 0) return { ok: false, message: plan.headerErrors.join(" ") };
  if (plan.valid.length + plan.rejected.length > MAX_IMPORT_ROWS) {
    return { ok: false, message: `This file has more than ${MAX_IMPORT_ROWS} rows.` };
  }

  const pending = plan.valid.filter((row) => row.line > afterLine);
  const batch = pending.slice(0, IMPORT_BATCH_SIZE);
  if (batch.length === 0) {
    return { ok: true, created: 0, duplicates: 0, clientsCreated: 0, rejected: [], lastLine: afterLine, hasMore: false, batchSize: 0 };
  }

  let result;
  try {
    result = await importInvoices(userId, batch, systemClock);
  } catch (err) {
    return { ok: false, message: describeEngineError(err) };
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    created: result.created,
    duplicates: result.duplicates,
    clientsCreated: result.clientsCreated,
    rejected: result.rejected,
    lastLine: batch[batch.length - 1].line,
    hasMore: pending.length > batch.length,
    batchSize: batch.length,
  };
}
