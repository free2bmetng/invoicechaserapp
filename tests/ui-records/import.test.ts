// CSV import: the preview, the batched commit through importInvoices, duplicate handling, limits,
// and the rule that a second run of the same file imports nothing new.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class NextRedirect extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { session: { userId: null as string | null }, NextRedirect };
});

vi.mock("@/lib/session", () => ({
  requireUserId: async () => {
    if (!h.session.userId) throw new h.NextRedirect("/login");
    return h.session.userId;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, updateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.NextRedirect(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { closeDb } from "@/lib/db";
import { commitImportBatchAction, previewImportAction } from "@/app/actions/import";
import { IDLE_IMPORT_PREVIEW, IMPORT_BATCH_SIZE, IMPORT_MAX_BYTES, type CommitBatchResult, type ImportPreviewState } from "@/components/invoices/import-types";
import { resetDb } from "../helpers/db";
import { makeClient, makeInvoice, makeUser, scalar, type TestUser } from "./fixtures";

const HEADER = "client_name,client_email,invoice_number,amount,currency,issue_date,due_date";

function csvOf(rows: string[], header = HEADER): string {
  return [header, ...rows].join("\n") + "\n";
}

function uploadOf(text: string, name = "invoices.csv"): FormData {
  const data = new FormData();
  data.append("file", new File([text], name, { type: "text/csv" }));
  return data;
}

async function commitAll(text: string): Promise<{ calls: CommitBatchResult[]; created: number; rejected: { line: number; reason: string }[] }> {
  const calls: CommitBatchResult[] = [];
  let afterLine = 0;
  let created = 0;
  const rejected: { line: number; reason: string }[] = [];
  for (let i = 0; i < 50; i++) {
    const result = await commitImportBatchAction(text, afterLine);
    calls.push(result);
    if (!result.ok) throw new Error(result.message);
    created += result.created;
    rejected.push(...result.rejected);
    if (!result.hasMore) break;
    afterLine = result.lastLine;
  }
  return { calls, created, rejected };
}

async function invoiceCount(userId: string): Promise<number> {
  return Number(await scalar("select count(*)::text from invoices where user_id = $1", [userId]));
}

let owner: TestUser;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser();
  h.session.userId = owner.userId;
});

afterAll(async () => {
  await closeDb();
});

describe("authorization", () => {
  it("refuses the preview and the commit without a session", async () => {
    h.session.userId = null;
    await expect(previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(csvOf([])))).rejects.toMatchObject({ url: "/login" });
    await expect(commitImportBatchAction(csvOf([]), 0)).rejects.toMatchObject({ url: "/login" });
    expect(await invoiceCount(owner.userId)).toBe(0);
  });
});

describe("previewImportAction", () => {
  it("asks for a file when none is uploaded", async () => {
    const state = await previewImportAction(IDLE_IMPORT_PREVIEW, new FormData());
    expect(state).toEqual({ stage: "error", message: "Choose a CSV file to upload." });
  });

  it("reports a missing required column and imports nothing", async () => {
    const state = await previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(csvOf(["Acme,a@acme.test,1,1.00,USD,2026-10-01,2027-01-01"], "client_name,client_email,amount")));
    expect(state.stage).toBe("error");
    if (state.stage !== "error") return;
    expect(state.message).toMatch(/Missing required columns?: /);
  });

  it("refuses a file over 2 MB before reading it into memory", async () => {
    const big = "a".repeat(IMPORT_MAX_BYTES + 1);
    const state = await previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(big));
    expect(state).toEqual({
      stage: "error",
      message: "This file is larger than 2 MB. Split it into smaller files, each under 2 MB, and import each one.",
    });
  });

  it("counts valid, rejected and duplicate rows, and lists every reason", async () => {
    const existing = await makeClient(owner.userId, { email: "dup@dup.test" });
    await makeInvoice(owner.userId, existing.clientId, { number: "INV-9", amountMinor: 125000 });

    const text = csvOf([
      "Acme Ltd,accounts@acme.test,INV-1,1250.00,USD,2026-10-01,2027-06-15",
      "Beta Co,beta@beta.test,INV-2,99.99,EUR,2026-10-02,2027-06-20",
      "Gamma,gamma@gamma.test,INV-3,12.345,USD,2026-10-03,2027-06-20",
      "Dup,dup@dup.test,INV-9,10.00,USD,2026-10-01,2027-06-20",
    ]);
    const state = await previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(text));
    expect(state.stage).toBe("preview");
    if (state.stage !== "preview") return;
    expect(state.totalRows).toBe(4);
    expect(state.validCount).toBe(2);
    expect(state.rejectedCount).toBe(2);
    expect(state.duplicates).toBe(1);
    expect(state.csvText).toBe(text);
    expect(state.validSample.map((r) => r.amount)).toEqual(["$1,250.00", "€99.99"]);

    const gamma = state.rejected.find((r) => r.raw.invoice_number === "INV-3");
    expect(gamma?.line).toBe(4);
    expect(gamma?.reasons.join(" ")).toMatch(/at most 2 decimal places/);
    const dup = state.rejected.find((r) => r.raw.invoice_number === "INV-9");
    expect(dup?.reasons.join(" ")).toMatch(/already exists/);
    // Rejected rows are plain objects, so they can be sent to the browser.
    expect(Object.getPrototypeOf(gamma?.raw)).toBe(Object.prototype);
  });
});

describe("commitImportBatchAction", () => {
  it("imports only the valid rows, creates their clients, and rejects a duplicate without overwriting it", async () => {
    const existing = await makeClient(owner.userId, { email: "dup@dup.test" });
    await makeInvoice(owner.userId, existing.clientId, { number: "INV-9", amountMinor: 125000 });
    const text = csvOf([
      "Acme Ltd,accounts@acme.test,INV-1,1250.00,USD,2026-10-01,2027-06-15",
      "Beta Co,beta@beta.test,INV-2,99.99,EUR,2026-10-02,2027-06-20",
      "Gamma,gamma@gamma.test,INV-3,12.345,USD,2026-10-03,2027-06-20",
      "Dup,dup@dup.test,INV-9,10.00,USD,2026-10-01,2027-06-20",
    ]);

    const first = await commitImportBatchAction(text, 0);
    expect(first).toMatchObject({ ok: true, created: 2, clientsCreated: 2, hasMore: false, batchSize: 2, lastLine: 3 });
    expect(await invoiceCount(owner.userId)).toBe(3);
    expect(await scalar("select count(*)::text from invoices where invoice_number = 'INV-3'")).toBe("0");
    expect(await scalar("select amount_minor::text from invoices where invoice_number = 'INV-9' and user_id = $1", [owner.userId])).toBe("125000");
    expect(await scalar("select source from invoices where invoice_number = 'INV-1' and user_id = $1", [owner.userId])).toBe("csv");
    expect(await scalar("select status from invoices where invoice_number = 'INV-1' and user_id = $1", [owner.userId])).toBe("open");
  });

  it("a second run of the same file imports nothing new", async () => {
    const text = csvOf([
      "Acme Ltd,accounts@acme.test,INV-1,1250.00,USD,2026-10-01,2027-06-15",
      "Beta Co,beta@beta.test,INV-2,99.99,EUR,2026-10-02,2027-06-20",
    ]);
    const first = await commitAll(text);
    expect(first.created).toBe(2);
    const countAfterFirst = await invoiceCount(owner.userId);

    const second = await commitImportBatchAction(text, 0);
    expect(second).toMatchObject({ ok: true, created: 0, duplicates: 0, batchSize: 0, hasMore: false });
    expect(await invoiceCount(owner.userId)).toBe(countAfterFirst);
  });

  it("imports in batches of 500 through importInvoices, one server call per batch", async () => {
    const rows: string[] = [];
    for (let i = 1; i <= 1200; i++) {
      rows.push(`Client ${i},client${i}@batch.test,B-${i},10.00,USD,2026-10-01,2027-06-15`);
    }
    const { calls, created } = await commitAll(csvOf(rows));
    expect(calls.map((c) => (c.ok ? c.batchSize : -1))).toEqual([IMPORT_BATCH_SIZE, IMPORT_BATCH_SIZE, 200]);
    expect(created).toBe(1200);
    expect(await invoiceCount(owner.userId)).toBe(1200);
    expect(calls[0].ok && calls[0].hasMore).toBe(true);
    expect(calls[2].ok && calls[2].hasMore).toBe(false);
  }, 120_000);

  it("reports a row the engine rejects and moves past it, so the import still finishes", async () => {
    const text = csvOf([
      `${"x".repeat(201)},long@name.test,INV-LONG,10.00,USD,2026-10-01,2027-06-15`,
      "Fine,fine@fine.test,INV-OK,10.00,USD,2026-10-01,2027-06-15",
    ]);
    const { calls, created, rejected } = await commitAll(text);
    expect(created).toBe(1);
    expect(rejected).toEqual([{ line: 2, reason: "Client name must be 200 characters or fewer." }]);
    expect(calls.at(-1)).toMatchObject({ ok: true, hasMore: false });
  });

  it("refuses a missing, oversized, malformed or out-of-range commit", async () => {
    expect(await commitImportBatchAction("", 0)).toMatchObject({ ok: false, message: "The file is missing. Upload it again." });
    expect(await commitImportBatchAction("a".repeat(IMPORT_MAX_BYTES + 1), 0)).toMatchObject({ ok: false });
    expect(await commitImportBatchAction(csvOf(["Acme,a@acme.test,1,1.00,USD,2026-10-01,2027-06-15"], "client_name,amount"), 0))
      .toMatchObject({ ok: false });
    expect(await commitImportBatchAction(csvOf([]), -1)).toMatchObject({ ok: false });
    expect(await invoiceCount(owner.userId)).toBe(0);
  });

  it("refuses a file over the 5,000-row limit", async () => {
    const rows: string[] = [];
    for (let i = 1; i <= 5001; i++) rows.push(`C${i},c${i}@limit.test,L-${i},1.00,USD,2026-10-01,2027-06-15`);
    const text = csvOf(rows);
    const result = await commitImportBatchAction(text, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/limit is 5000/);
    const preview = await previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(text));
    expect(preview.stage).toBe("error");
    expect(await invoiceCount(owner.userId)).toBe(0);
  }, 60_000);
});

describe("preview state", () => {
  it("keeps the other user's invoices out of the duplicate check", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId, { email: "shared@client.test" });
    await makeInvoice(other.userId, theirs.clientId, { number: "INV-SHARED" });
    const text = csvOf(["Shared,shared@client.test,INV-SHARED,10.00,USD,2026-10-01,2027-06-15"]);
    const state: ImportPreviewState = await previewImportAction(IDLE_IMPORT_PREVIEW, uploadOf(text));
    expect(state.stage).toBe("preview");
    if (state.stage !== "preview") return;
    expect(state.duplicates).toBe(0);
    expect(state.validCount).toBe(1);
  });
});
