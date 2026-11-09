// CSV import planning (validate every row, report every reason, import nothing
// until the user confirms) and an RFC 4180 writer for exports.
import { parse } from "csv-parse/sync";
import { isKnownCurrency, normalizeCurrency, parseMoneyToMinor } from "./money";

export const INVOICE_CSV_HEADERS: readonly string[] = [
  "client_name",
  "client_email",
  "invoice_number",
  "amount",
  "currency",
  "issue_date",
  "due_date",
];

export const MAX_IMPORT_ROWS = 5000;

const MAX_INVOICE_NUMBER_CHARS = 64;
const MAX_EMAIL_CHARS = 254;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export interface ImportRow {
  line: number;
  clientName: string;
  clientEmail: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
}

export interface RejectedRow {
  line: number;
  reasons: string[];
  // Untrimmed cell values keyed by normalized (trimmed, lower-case) header name.
  raw: Record<string, string>;
}

export interface CsvImportPlan {
  // File-level problems. When this is non-empty, no rows are imported.
  headerErrors: string[];
  valid: ImportRow[];
  rejected: RejectedRow[];
  // Rejected rows caused by a duplicate, against existing invoices or earlier rows.
  duplicates: number;
}

// Returns the YYYY-MM-DD string if it is a real calendar date, otherwise null.
export function parseIsoDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Shortens user input for an error message.
function shown(value: string): string {
  const chars = Array.from(value);
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}...` : value;
}

function checkDate(raw: string, column: string, reasons: string[]): string | null {
  if (raw === "") {
    reasons.push(`${column} is required.`);
    return null;
  }
  const iso = parseIsoDate(raw);
  if (iso === null) {
    reasons.push(`${column} must be a real date in YYYY-MM-DD format, such as 2026-11-08 (got "${shown(raw)}").`);
  }
  return iso;
}

interface ParsedRecord {
  record: string[];
  info: { lines: number };
}

// Parses the file, validates every data row and reports every reason per row.
// existingKeys holds "client_email|invoice_number" for invoices already stored.
// Keys are compared with the email lower-cased and the invoice number as written.
// today is the user's local date as YYYY-MM-DD. An issue date after it is rejected.
export function planCsvImport(text: string, existingKeys: Set<string>, today: string): CsvImportPlan {
  if (typeof text !== "string") throw new TypeError("planCsvImport expects the file contents as text.");
  const todayIso = parseIsoDate(today);
  if (todayIso === null) throw new TypeError("today must be a YYYY-MM-DD date.");

  const plan: CsvImportPlan = { headerErrors: [], valid: [], rejected: [], duplicates: 0 };

  let records: ParsedRecord[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    }) as unknown as ParsedRecord[];
  } catch (err) {
    plan.headerErrors.push(`The file could not be read as CSV. ${errorMessage(err)}`);
    return plan;
  }

  // Blank records (whitespace-only lines, trailing spreadsheet rows of commas) are not rows.
  records = records.filter((r) => r.record.some((cell) => cell.trim() !== ""));
  if (records.length === 0) {
    plan.headerErrors.push("The file is empty. Include a header row and at least one invoice row.");
    return plan;
  }

  const headers = records[0].record.map((name) => name.trim().toLowerCase());
  const columnIndex = new Map<string, number>();
  const missing: string[] = [];
  for (const column of INVOICE_CSV_HEADERS) {
    const positions = headers.flatMap((name, index) => (name === column ? [index] : []));
    if (positions.length === 0) missing.push(column);
    else if (positions.length > 1) plan.headerErrors.push(`The column "${column}" appears more than once.`);
    else columnIndex.set(column, positions[0]);
  }
  if (missing.length > 0) {
    plan.headerErrors.push(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  }
  if (plan.headerErrors.length > 0) return plan;

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    plan.headerErrors.push("The file has a header row but no invoice rows.");
    return plan;
  }
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    plan.headerErrors.push(
      `This file has ${dataRecords.length} rows. The limit is ${MAX_IMPORT_ROWS} rows per import, so split the file and import each part.`,
    );
    return plan;
  }

  // A key is claimed only by a row that is otherwise valid. An invalid row does not block a later valid row.
  const acceptedLines = new Map<string, number>();

  for (const { record, info } of dataRecords) {
    // info.lines is the line where the record ends. Subtract the newlines inside quoted fields to get the start line.
    const embeddedNewlines = record.reduce((count, cell) => count + (cell.match(/\n/g)?.length ?? 0), 0);
    const line = info.lines - embeddedNewlines;

    const raw: Record<string, string> = Object.create(null);
    headers.forEach((name, index) => {
      if (!(name in raw)) raw[name] = record[index] ?? "";
    });
    const cell = (column: string): string => raw[column] ?? "";

    const clientName = cell("client_name").trim();
    const clientEmail = cell("client_email").trim().toLowerCase();
    const invoiceNumber = cell("invoice_number").trim();
    const currencyRaw = cell("currency").trim();
    const amountRaw = cell("amount").trim();

    const reasons: string[] = [];

    if (clientName === "") reasons.push("client_name is required.");
    if (clientEmail === "") {
      reasons.push("client_email is required.");
    } else if (clientEmail.length > MAX_EMAIL_CHARS || !EMAIL.test(clientEmail)) {
      reasons.push(`client_email "${shown(clientEmail)}" is not a valid email address.`);
    }

    if (invoiceNumber === "") {
      reasons.push("invoice_number is required.");
    } else if (Array.from(invoiceNumber).length > MAX_INVOICE_NUMBER_CHARS) {
      reasons.push(`invoice_number must be ${MAX_INVOICE_NUMBER_CHARS} characters or fewer.`);
    }

    const currency = normalizeCurrency(currencyRaw);
    const currencyOk = isKnownCurrency(currency);
    if (currencyRaw === "") {
      reasons.push("currency is required.");
    } else if (!currencyOk) {
      reasons.push(`currency must be an ISO 4217 code such as USD (got "${shown(currencyRaw)}").`);
    }

    // The allowed decimal places depend on the currency, so the amount is checked only when the currency is valid.
    let amountMinor = 0;
    if (amountRaw === "") {
      reasons.push("amount is required.");
    } else if (currencyOk) {
      try {
        amountMinor = parseMoneyToMinor(amountRaw, currency);
        if (amountMinor <= 0) reasons.push("amount must be greater than zero.");
      } catch (err) {
        reasons.push(errorMessage(err));
      }
    }

    const issueDate = checkDate(cell("issue_date").trim(), "issue_date", reasons);
    const dueDate = checkDate(cell("due_date").trim(), "due_date", reasons);
    if (issueDate !== null && issueDate > todayIso) reasons.push("issue_date cannot be in the future.");
    if (issueDate !== null && dueDate !== null && dueDate < issueDate) {
      reasons.push("due_date must be on or after issue_date.");
    }

    // Every reason is listed, so a duplicate is reported even when the row has other problems.
    const key = clientEmail !== "" && invoiceNumber !== "" ? `${clientEmail}|${invoiceNumber}` : null;
    let duplicate = false;
    if (key !== null) {
      if (existingKeys.has(key)) {
        reasons.push(`Invoice "${invoiceNumber}" for ${clientEmail} already exists. Existing invoices are never overwritten.`);
        duplicate = true;
      }
      const firstLine = acceptedLines.get(key);
      if (firstLine !== undefined) {
        reasons.push(`Duplicate of line ${firstLine} in this file.`);
        duplicate = true;
      }
    }

    if (reasons.length === 0 && key !== null && issueDate !== null && dueDate !== null) {
      plan.valid.push({
        line,
        clientName,
        clientEmail,
        invoiceNumber,
        amountMinor,
        currency,
        issueDate,
        dueDate,
      });
      acceptedLines.set(key, line);
    } else {
      plan.rejected.push({ line, reasons, raw });
      if (duplicate) plan.duplicates += 1;
    }
  }

  return plan;
}

// RFC 4180: CRLF line endings. A cell is quoted when it contains a comma, a double
// quote or a line break, and inner double quotes are doubled. Formula escaping is
// the caller's job (see csvSafeCell).
export function writeCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows
    .map((row) => row.map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .map((line) => `${line}\r\n`)
    .join("");
}
