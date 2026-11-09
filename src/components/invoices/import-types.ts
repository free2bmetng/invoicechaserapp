// Client-safe types and limits for the CSV import. The server actions return these shapes.
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_BATCH_SIZE = 500;

export interface RejectedView {
  line: number;
  reasons: string[];
  raw: Record<string, string>;
}

export interface ValidView {
  line: number;
  clientName: string;
  clientEmail: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
}

export type ImportPreviewState =
  | { stage: "idle"; message: null }
  | { stage: "error"; message: string }
  | {
      stage: "preview";
      message: null;
      csvText: string;
      totalRows: number;
      validCount: number;
      rejectedCount: number;
      duplicates: number;
      rejected: RejectedView[];
      validSample: ValidView[];
    };

export const IDLE_IMPORT_PREVIEW: ImportPreviewState = { stage: "idle", message: null };

export type CommitBatchResult =
  | {
      ok: true;
      created: number;
      duplicates: number;
      clientsCreated: number;
      rejected: { line: number; reason: string }[];
      // The cursor for the next call: the last line this batch handled.
      lastLine: number;
      hasMore: boolean;
      batchSize: number;
    }
  | { ok: false; message: string };
