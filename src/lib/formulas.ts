// Spreadsheet formula injection guard for exported CSV cells. A cell that starts
// with one of these characters is evaluated as a formula by Excel and Sheets, so
// it gets a leading apostrophe. Every other value is returned unchanged.
const FORMULA_LEADERS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvSafeCell(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  return FORMULA_LEADERS.has(value[0]) ? `'${value}` : value;
}
