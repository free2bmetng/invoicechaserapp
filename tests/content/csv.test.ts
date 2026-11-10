import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { INVOICE_CSV_HEADERS, MAX_IMPORT_ROWS, planCsvImport, writeCsv } from "@/lib/csv";

const TODAY = "2026-11-09";
const HEADER = "client_name,client_email,invoice_number,amount,currency,issue_date,due_date";
const ROW_OK = "Acme Ltd,billing@acme.test,INV-1,1234.50,USD,2026-11-01,2026-11-15";
const NO_KEYS = new Set<string>();

function csvText(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

function reasonsOf(row: string): string[] {
  const plan = planCsvImport(csvText(row), NO_KEYS, TODAY);
  expect(plan.headerErrors).toEqual([]);
  expect(plan.valid).toHaveLength(0);
  expect(plan.rejected).toHaveLength(1);
  return plan.rejected[0].reasons;
}

describe("planCsvImport: a valid file", () => {
  it("converts each valid row, keeping file order and line numbers", () => {
    const plan = planCsvImport(csvText(ROW_OK, "Bob Co,BOB@Example.test,INV-2,10,jpy,2026-10-01,2026-10-31"), NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.duplicates).toBe(0);
    expect(plan.valid).toEqual([
      {
        line: 2,
        clientName: "Acme Ltd",
        clientEmail: "billing@acme.test",
        invoiceNumber: "INV-1",
        amountMinor: 123450,
        currency: "USD",
        issueDate: "2026-11-01",
        dueDate: "2026-11-15",
      },
      {
        line: 3,
        clientName: "Bob Co",
        clientEmail: "bob@example.test",
        invoiceNumber: "INV-2",
        amountMinor: 10,
        currency: "JPY",
        issueDate: "2026-10-01",
        dueDate: "2026-10-31",
      },
    ]);
  });

  it("publishes the seven required headers", () => {
    expect([...INVOICE_CSV_HEADERS]).toEqual([
      "client_name",
      "client_email",
      "invoice_number",
      "amount",
      "currency",
      "issue_date",
      "due_date",
    ]);
    expect(MAX_IMPORT_ROWS).toBe(5000);
  });

  it("accepts headers in any order, in any case, with spaces and a byte-order mark, and ignores extra columns", () => {
    const text = "﻿ Amount , Client_Email,client_name,invoice_number,Currency,due_date,issue_date,notes\n 1234.50 ,a@b.test,Acme,INV-9,usd,2026-11-15,2026-11-01,call Tuesday";
    const plan = planCsvImport(text, NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual([]);
    expect(plan.valid).toEqual([
      {
        line: 2,
        clientName: "Acme",
        clientEmail: "a@b.test",
        invoiceNumber: "INV-9",
        amountMinor: 123450,
        currency: "USD",
        issueDate: "2026-11-01",
        dueDate: "2026-11-15",
      },
    ]);
  });

  it("skips fully blank rows, which do not count and do not shift later line numbers", () => {
    const text = [HEADER, "", ROW_OK, ",,,,,,,", "Bob Co,bob@example.test,INV-2,10,USD,2026-11-01,2026-11-15"].join("\n");
    const plan = planCsvImport(text, NO_KEYS, TODAY);
    expect(plan.rejected).toEqual([]);
    expect(plan.valid.map((r) => r.line)).toEqual([3, 5]);
  });

  it("reports the starting line of a row whose quoted field spans several lines", () => {
    const text = [HEADER, '"Acme\nLtd",billing@acme.test,INV-1,1234.50,USD,2026-11-01,2026-11-15', ROW_OK.replace("INV-1", "INV-2")].join("\n");
    const plan = planCsvImport(text, NO_KEYS, TODAY);
    expect(plan.valid.map((r) => [r.line, r.clientName])).toEqual([
      [2, "Acme\nLtd"],
      [4, "Acme Ltd"],
    ]);
  });

  it("handles quoted commas and CRLF line endings", () => {
    const text = `${HEADER}\r\n"Acme, Ltd",billing@acme.test,INV-1,1234.50,USD,2026-11-01,2026-11-15\r\n`;
    const plan = planCsvImport(text, NO_KEYS, TODAY);
    expect(plan.valid[0].clientName).toBe("Acme, Ltd");
  });

  it("ignores cells beyond the header and fills missing trailing cells with blanks", () => {
    const plan = planCsvImport(csvText(`${ROW_OK},extra,more`), NO_KEYS, TODAY);
    expect(plan.valid).toHaveLength(1);
    const short = planCsvImport(csvText("Acme,billing@acme.test"), NO_KEYS, TODAY);
    expect(short.valid).toEqual([]);
    expect(short.rejected[0].reasons).toEqual(
      expect.arrayContaining(["invoice_number is required.", "currency is required.", "issue_date is required."]),
    );
  });
});

describe("planCsvImport: file-level errors import nothing", () => {
  it("reports a missing required column and yields no rows", () => {
    const text = "client_name,client_email,invoice_number,amount,currency,due_date\nAcme,a@b.test,INV-1,10,USD,2026-11-15";
    const plan = planCsvImport(text, NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual(["Missing required column: issue_date."]);
    expect(plan.valid).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.duplicates).toBe(0);
  });

  it("lists every missing column", () => {
    const plan = planCsvImport("client_name,amount\nAcme,10", NO_KEYS, TODAY);
    expect(plan.headerErrors[0]).toContain("client_email");
    expect(plan.headerErrors[0]).toContain("issue_date");
    expect(plan.valid).toEqual([]);
  });

  it("reports a required column that appears twice, after normalizing case and spaces", () => {
    const plan = planCsvImport(`${HEADER},Amount\n${ROW_OK},10`, NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual(['The column "amount" appears more than once.']);
    expect(plan.valid).toEqual([]);
  });

  it("does not treat duplicated extra columns as an error", () => {
    const plan = planCsvImport(`${HEADER},notes,NOTES\n${ROW_OK},a,b`, NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual([]);
    expect(plan.valid).toHaveLength(1);
  });

  it("reports an empty file", () => {
    expect(planCsvImport("", NO_KEYS, TODAY).headerErrors[0]).toMatch(/empty/);
    expect(planCsvImport("   \n  \n", NO_KEYS, TODAY).headerErrors[0]).toMatch(/empty/);
  });

  it("reports a header with no rows", () => {
    const plan = planCsvImport(HEADER, NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual(["The file has a header row but no invoice rows."]);
  });

  it("reports unreadable CSV rather than throwing", () => {
    const plan = planCsvImport(`${HEADER}\n"Acme,a@b.test,INV-1,10,USD,2026-11-01,2026-11-15\n`, NO_KEYS, TODAY);
    expect(plan.headerErrors).toHaveLength(1);
    expect(plan.headerErrors[0]).toMatch(/could not be read as CSV/);
    expect(plan.valid).toEqual([]);
  });

  it("refuses more than 5000 data rows and imports nothing", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Client ${i},c${i}@example.test,INV-${i},10,USD,2026-11-01,2026-11-15`);
    const plan = planCsvImport(csvText(...rows), NO_KEYS, TODAY);
    expect(plan.headerErrors).toHaveLength(1);
    expect(plan.headerErrors[0]).toContain(String(MAX_IMPORT_ROWS + 1));
    expect(plan.valid).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it("accepts exactly 5000 data rows", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `Client ${i},c${i}@example.test,INV-${i},10,USD,2026-11-01,2026-11-15`);
    const plan = planCsvImport(csvText(...rows), NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual([]);
    expect(plan.valid).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("does not count blank rows toward the 5000-row limit", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `Client ${i},c${i}@example.test,INV-${i},10,USD,2026-11-01,2026-11-15`);
    rows.push(",,,,,,", ",,,,,,");
    const plan = planCsvImport(csvText(...rows), NO_KEYS, TODAY);
    expect(plan.headerErrors).toEqual([]);
    expect(plan.valid).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("throws for a malformed today value or non-text input", () => {
    expect(() => planCsvImport(csvText(ROW_OK), NO_KEYS, "2026-13-01")).toThrow(TypeError);
    expect(() => planCsvImport(csvText(ROW_OK), NO_KEYS, "tomorrow")).toThrow(TypeError);
    expect(() => planCsvImport(undefined as unknown as string, NO_KEYS, TODAY)).toThrow(TypeError);
  });
});

describe("planCsvImport: amounts and currencies", () => {
  it.each([
    ["1,234.50", 123450],
    ["12,345", 1234500],
    ["1,234,567.89", 123456789],
  ])("accepts strict thousands separators: %s", (amount, minor) => {
    const plan = planCsvImport(csvText(`Acme,a@b.test,INV-1,"${amount}",USD,2026-11-01,2026-11-15`), NO_KEYS, TODAY);
    expect(plan.rejected).toEqual([]);
    expect(plan.valid[0].amountMinor).toBe(minor);
  });

  it.each(["1,25", "12,50,000", "1,2345.00", ",123", "1,234,5"])("rejects a comma that is not a thousands separator: %s", (amount) => {
    expect(reasonsOf(`Acme,a@b.test,INV-1,"${amount}",USD,2026-11-01,2026-11-15`)).toEqual([
      `amount "${amount}" is unclear. Use "." for decimals, such as 1250.00 or 1,250.00.`,
    ]);
  });

  it.each([
    ["-5", /negative/],
    ["0", /greater than zero/],
    ["0.00", /greater than zero/],
    ["NaN", /plain number/],
    ["1e3", /plain number/],
    ["12.345", /at most 2 decimal places/],
  ])("rejects amount %j", (amount, message) => {
    const reasons = reasonsOf(`Acme,a@b.test,INV-1,${amount},USD,2026-11-01,2026-11-15`);
    expect(reasons.join(" ")).toMatch(message);
  });

  it("rejects an empty amount", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,,USD,2026-11-01,2026-11-15")).toEqual(["amount is required."]);
  });

  it("applies the currency's decimal places: JPY rejects cents, accepts whole yen", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,100.5,JPY,2026-11-01,2026-11-15").join(" ")).toMatch(/no decimal places/);
    const ok = planCsvImport(csvText("Acme,a@b.test,INV-1,100,JPY,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(ok.valid[0].amountMinor).toBe(100);
  });

  it("accepts three decimal places for BHD", () => {
    const ok = planCsvImport(csvText("Acme,a@b.test,INV-1,1.234,BHD,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(ok.valid[0].amountMinor).toBe(1234);
  });

  it("normalizes a lower-case currency code to ISO upper case", () => {
    const ok = planCsvImport(csvText("Acme,a@b.test,INV-1,10,usd,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(ok.valid[0].currency).toBe("USD");
  });

  it("rejects an unknown or malformed currency code", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,10,ZZZ,2026-11-01,2026-11-15")).toEqual([
      'currency must be an ISO 4217 code such as USD (got "ZZZ").',
    ]);
    expect(reasonsOf("Acme,a@b.test,INV-1,10,US,2026-11-01,2026-11-15").join(" ")).toMatch(/ISO 4217/);
    expect(reasonsOf("Acme,a@b.test,INV-1,10,,2026-11-01,2026-11-15")).toEqual(["currency is required."]);
  });

  it("does not check the amount when the currency is invalid, because the allowed decimals depend on it", () => {
    const reasons = reasonsOf("Acme,a@b.test,INV-1,abc,XYZ,2026-11-01,2026-11-15");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/currency/);
  });
});

describe("planCsvImport: dates", () => {
  it.each([
    ["2026-02-30", /real date/],
    ["2023-02-29", /real date/],
    ["2026-13-01", /real date/],
    ["2026-00-10", /real date/],
    ["2026-2-3", /real date/],
    ["03/11/2026", /real date/],
    ["2026-11-08T00:00", /real date/],
  ])("rejects issue date %j", (date, message) => {
    expect(reasonsOf(`Acme,a@b.test,INV-1,10,USD,${date},2026-11-15`).join(" ")).toMatch(message);
  });

  it("accepts 29 February in a leap year", () => {
    const plan = planCsvImport(csvText("Acme,a@b.test,INV-1,10,USD,2024-02-29,2024-03-15"), NO_KEYS, TODAY);
    expect(plan.valid[0].issueDate).toBe("2024-02-29");
  });

  it("rejects a due date before the issue date, and accepts the same day", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,10,USD,2026-11-05,2026-11-04")).toEqual([
      "due_date must be on or after issue_date.",
    ]);
    const same = planCsvImport(csvText("Acme,a@b.test,INV-1,10,USD,2026-11-05,2026-11-05"), NO_KEYS, TODAY);
    expect(same.valid).toHaveLength(1);
  });

  it("rejects an issue date after today, and accepts today", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,10,USD,2026-11-10,2026-12-10")).toEqual([
      "issue_date cannot be in the future.",
    ]);
    const today = planCsvImport(csvText("Acme,a@b.test,INV-1,10,USD,2026-11-09,2026-12-10"), NO_KEYS, TODAY);
    expect(today.valid).toHaveLength(1);
  });

  it("accepts a due date in the past, because overdue invoices are the point of the app", () => {
    const plan = planCsvImport(csvText("Acme,a@b.test,INV-1,10,USD,2019-01-01,2019-02-01"), NO_KEYS, TODAY);
    expect(plan.valid).toHaveLength(1);
  });

  it("requires both dates", () => {
    expect(reasonsOf("Acme,a@b.test,INV-1,10,USD,,")).toEqual(["issue_date is required.", "due_date is required."]);
  });
});

describe("planCsvImport: client and invoice fields", () => {
  it("lower-cases and validates the client email", () => {
    const plan = planCsvImport(csvText("Acme,  Billing@Acme.TEST  ,INV-1,10,USD,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(plan.valid[0].clientEmail).toBe("billing@acme.test");
  });

  it.each([
    ["not-an-email"],
    ["a b@c.test"],
    ["a@b"],
    ["@c.test"],
  ])("rejects client email %j", (email) => {
    expect(reasonsOf(`Acme,${email},INV-1,10,USD,2026-11-01,2026-11-15`).join(" ")).toMatch(/not a valid email address/);
  });

  it("requires a client email and a client name", () => {
    expect(reasonsOf(",,INV-1,10,USD,2026-11-01,2026-11-15")).toEqual([
      "client_name is required.",
      "client_email is required.",
    ]);
  });

  it("requires an invoice number, trims it, and caps it at 64 characters", () => {
    expect(reasonsOf("Acme,a@b.test,,10,USD,2026-11-01,2026-11-15")).toEqual(["invoice_number is required."]);
    expect(reasonsOf(`Acme,a@b.test,${"x".repeat(65)},10,USD,2026-11-01,2026-11-15`)).toEqual([
      "invoice_number must be 64 characters or fewer.",
    ]);
    const exact = planCsvImport(csvText(`Acme,a@b.test,${"x".repeat(64)},10,USD,2026-11-01,2026-11-15`), NO_KEYS, TODAY);
    expect(exact.valid).toHaveLength(1);
    const emoji = planCsvImport(csvText(`Acme,a@b.test,${"😀".repeat(64)},10,USD,2026-11-01,2026-11-15`), NO_KEYS, TODAY);
    expect(emoji.valid).toHaveLength(1);
    const trimmed = planCsvImport(csvText("Acme,a@b.test,  INV-7  ,10,USD,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(trimmed.valid[0].invoiceNumber).toBe("INV-7");
  });

  it("keeps the untrimmed cell values in raw, keyed by header", () => {
    const plan = planCsvImport(csvText(" Acme ,  not-an-email ,INV-1,10,USD,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(plan.rejected[0].raw.client_email).toBe("  not-an-email ");
    expect(plan.rejected[0].raw.client_name).toBe(" Acme ");
    expect(plan.rejected[0].line).toBe(2);
  });
});

describe("planCsvImport: every rejected row lists every reason", () => {
  it("reports each independent problem, not only the first", () => {
    const reasons = reasonsOf(",not-an-email,,abc,ZZZ,2026-02-30,2026-11-15");
    expect(reasons).toEqual([
      "client_name is required.",
      expect.stringMatching(/client_email "not-an-email" is not a valid email address/),
      "invoice_number is required.",
      expect.stringMatching(/currency must be an ISO 4217 code/),
      expect.stringMatching(/issue_date must be a real date/),
    ]);
  });

  it("keeps rejected rows in order, with their own line numbers", () => {
    const plan = planCsvImport(csvText(ROW_OK, "Bad,bad,INV-2,10,USD,2026-11-01,2026-11-15", ROW_OK.replace("INV-1", "INV-3")), NO_KEYS, TODAY);
    expect(plan.valid.map((r) => r.line)).toEqual([2, 4]);
    expect(plan.rejected.map((r) => r.line)).toEqual([3]);
  });
});

describe("planCsvImport: existing invoices and duplicates", () => {
  it("rejects a row whose client email and invoice number already exist, without overwriting", () => {
    const plan = planCsvImport(csvText(ROW_OK), new Set(["billing@acme.test|INV-1"]), TODAY);
    expect(plan.valid).toEqual([]);
    expect(plan.duplicates).toBe(1);
    expect(plan.rejected[0].reasons[0]).toMatch(/already exists/);
    expect(plan.rejected[0].reasons[0]).toMatch(/never overwritten/);
  });

  it("matches the client email case-insensitively against existing keys", () => {
    const plan = planCsvImport(csvText("Bob,BOB@Example.TEST,INV-9,10,USD,2026-11-01,2026-11-15"), new Set(["bob@example.test|INV-9"]), TODAY);
    expect(plan.duplicates).toBe(1);
  });

  it("matches the invoice number exactly, as the database does", () => {
    const plan = planCsvImport(csvText("Bob,bob@example.test,INV-9,10,USD,2026-11-01,2026-11-15"), new Set(["bob@example.test|inv-9"]), TODAY);
    expect(plan.valid).toHaveLength(1);
    expect(plan.duplicates).toBe(0);
  });

  it("compares trimmed invoice numbers, so padding does not hide a duplicate", () => {
    const plan = planCsvImport(csvText("Acme,billing@acme.test,  INV-1  ,10,USD,2026-11-01,2026-11-15"), new Set(["billing@acme.test|INV-1"]), TODAY);
    expect(plan.duplicates).toBe(1);
  });

  it("rejects the second occurrence of a key within the file and points at the first", () => {
    const plan = planCsvImport(csvText(ROW_OK, ROW_OK.replace("Acme Ltd", "Acme Limited")), NO_KEYS, TODAY);
    expect(plan.valid.map((r) => r.line)).toEqual([2]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].line).toBe(3);
    expect(plan.rejected[0].reasons).toEqual(["Duplicate of line 2 in this file."]);
    expect(plan.duplicates).toBe(1);
  });

  it("does not let an invalid earlier row block a later valid row with the same key", () => {
    const bad = "Acme,billing@acme.test,INV-1,abc,USD,2026-11-01,2026-11-15";
    const plan = planCsvImport(csvText(bad, ROW_OK), NO_KEYS, TODAY);
    expect(plan.valid.map((r) => r.line)).toEqual([3]);
    expect(plan.rejected.map((r) => r.line)).toEqual([2]);
    expect(plan.duplicates).toBe(0);
  });

  it("lists a duplicate reason alongside other reasons and still counts it once", () => {
    const plan = planCsvImport(csvText(ROW_OK, "Acme,billing@acme.test,INV-1,abc,USD,2026-11-01,2026-11-15"), NO_KEYS, TODAY);
    expect(plan.rejected[0].reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/Duplicate of line 2/), expect.stringMatching(/plain number/)]),
    );
    expect(plan.duplicates).toBe(1);
  });

  it("lists an existing-invoice reason alongside other reasons", () => {
    const plan = planCsvImport(csvText("Acme,billing@acme.test,INV-1,,USD,2026-11-01,2026-11-15"), new Set(["billing@acme.test|INV-1"]), TODAY);
    expect(plan.rejected[0].reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/already exists/), "amount is required."]),
    );
    expect(plan.duplicates).toBe(1);
  });

  it("counts every duplicate across existing invoices and the file", () => {
    const text = csvText(
      "A,a@x.test,INV-1,10,USD,2026-11-01,2026-11-15",
      "A,a@x.test,INV-1,10,USD,2026-11-01,2026-11-15",
      "B,b@x.test,INV-2,10,USD,2026-11-01,2026-11-15",
      "C,c@x.test,INV-3,10,USD,2026-11-01,2026-11-15",
    );
    const plan = planCsvImport(text, new Set(["c@x.test|INV-3"]), TODAY);
    expect(plan.valid.map((r) => r.invoiceNumber)).toEqual(["INV-1", "INV-2"]);
    expect(plan.duplicates).toBe(2);
  });
});

describe("writeCsv", () => {
  it("terminates every record with CRLF and leaves plain cells unquoted", () => {
    expect(writeCsv([["a", "b"], ["1", ""]])).toBe("a,b\r\n1,\r\n");
  });

  it("quotes cells with commas, quotes or line breaks and doubles inner quotes", () => {
    const out = writeCsv([["a", "b,c"], ['say "hi"', "line\nbreak"]]);
    expect(out).toBe('a,"b,c"\r\n"say ""hi""","line\nbreak"\r\n');
  });

  it("round-trips through a standards-compliant parser", () => {
    const rows = [
      ["name", "note"],
      ["Acme, Ltd", 'a "quoted" word'],
      ["Multi", "two\nlines"],
      ["", "trailing,"],
    ];
    const parsed = parse(writeCsv(rows), { relax_column_count: false });
    expect(parsed).toEqual(rows);
  });

  it("returns an empty string for no rows", () => {
    expect(writeCsv([])).toBe("");
  });
});
