// Money as people type it. The parser in src/lib/money.ts stays strict ("1234.50" only), so the
// form layer turns what people actually type ("1,234.50", "£1 234.50", "1.234,50") into that
// strict form first, and formats the field for reading when it loses focus. Pure, client-safe.
import { currencyExponent, parseMoneyToMinor } from "@/lib/money";

// Spaces of every kind, currency signs, and a leading or trailing ISO code ("GBP 12", "12 EUR").
const NOISE = /[\s  '’_$£€¥₹₩₽₺₪₫฿₦₱₴₲₵₡₸]/g;

// Returns the strict "1234.50" text for a typed amount, or the input (trimmed) when it cannot be
// read, so the strict parser reports the problem in its own words.
export function normalizeMoneyInput(raw: string): string {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  if (text === "") return "";
  // Only an upper-case code counts ("GBP 12", "12EUR"); "12abc" stays as typed and is refused.
  text = text.replace(/^[A-Z]{3}(?=[\s\d.,])/, "").replace(/(?<=[\d.,\s])[A-Z]{3}$/, "");
  text = text.replace(NOISE, "");
  if (!/^\d[\d.,]*$|^[.,]\d+$/.test(text)) return raw.trim();

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  const dots = text.split(".").length - 1;
  const commas = text.split(",").length - 1;

  if (dots > 0 && commas > 0) {
    // Both appear: the last one is the decimal point, the other groups thousands.
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    if ((decimal === "." ? dots : commas) > 1) return raw.trim();
    return text.split(group).join("").replace(",", ".");
  }
  if (commas > 0) {
    // "1,234" and "1,234,567" group thousands; a single comma before 1 or 2 digits is a decimal comma.
    const groups = text.split(",");
    const thousands = groups.slice(1).every((g) => g.length === 3) && groups[0].length > 0 && groups[0].length <= 3;
    if (thousands) return groups.join("");
    if (commas === 1) return text.replace(",", ".");
    return raw.trim();
  }
  if (dots > 1) {
    // "1.234.567" groups thousands.
    const groups = text.split(".");
    const thousands = groups.slice(1).every((g) => g.length === 3) && groups[0].length > 0 && groups[0].length <= 3;
    return thousands ? groups.join("") : raw.trim();
  }
  return text;
}

// Strict minor units for a typed amount. Throws the parser's MoneyError when it cannot be read.
export function parseTypedMoney(raw: string, currency: string): number {
  return parseMoneyToMinor(normalizeMoneyInput(raw), currency);
}

// The field text after blur: "1,234.50" (grouped, the currency's own decimals, no symbol).
// Returns the input unchanged when it cannot be read, so the user can fix what they typed.
export function formatMoneyInput(raw: string, currency: string): string {
  const text = raw.trim();
  if (text === "") return "";
  let exponent: number;
  let minor: number;
  try {
    exponent = currencyExponent(currency);
    minor = parseTypedMoney(text, currency);
  } catch {
    return raw;
  }
  const digits = String(minor).padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return exponent === 0 ? grouped : `${grouped}.${digits.slice(-exponent)}`;
}
