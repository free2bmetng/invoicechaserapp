// Money is stored as integer minor units (cents, pence, yen). The number of
// minor digits comes from Intl, so JPY has 0, USD/EUR 2 and BHD 3 with no
// hand-kept table.

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const KNOWN_CURRENCIES = new Set<string>(Intl.supportedValuesOf("currency"));
const exponentCache = new Map<string, number>();

// Trims and upper-cases a currency code. Does not validate it.
export function normalizeCurrency(code: string): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

export function isKnownCurrency(code: string): boolean {
  const c = normalizeCurrency(code);
  return /^[A-Z]{3}$/.test(c) && KNOWN_CURRENCIES.has(c);
}

// Number of decimal places in the currency's minor unit (USD 2, JPY 0, BHD 3).
export function currencyExponent(code: string): number {
  const c = normalizeCurrency(code);
  if (!isKnownCurrency(c)) throw new MoneyError(`Unknown currency code "${code}".`);
  const cached = exponentCache.get(c);
  if (cached !== undefined) return cached;
  const digits = new Intl.NumberFormat("en-US", { style: "currency", currency: c }).resolvedOptions()
    .maximumFractionDigits;
  if (typeof digits !== "number") throw new MoneyError(`Cannot read minor units for "${c}".`);
  exponentCache.set(c, digits);
  return digits;
}

// Parses a plain decimal string such as "1234.50" into minor units.
// Accepts "." as the only decimal separator and no thousands separators, signs,
// exponents or other characters. Surrounding whitespace is ignored. Zero is
// accepted here; callers that need a positive amount must check it.
export function parseMoneyToMinor(input: string, currency: string): number {
  return parseMinorAmount(input, currencyExponent(currency));
}

// Same as parseMoneyToMinor but takes the number of minor digits directly.
export function parseMinorAmount(input: string, exponent: number): number {
  if (typeof input !== "string") throw new MoneyError("Amount must be text.");
  const text = input.trim();
  if (text === "") throw new MoneyError("Amount is required.");
  if (text.startsWith("-")) throw new MoneyError("Amount cannot be negative.");

  const match = /^(\d+)?(?:\.(\d+))?$/.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new MoneyError(
      'Amount must be a plain number such as 1234.50, with "." as the decimal point and no thousands separators.',
    );
  }

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    throw new MoneyError(
      exponent === 0
        ? "This currency has no decimal places, so enter a whole number."
        : `This currency allows at most ${exponent} decimal place${exponent === 1 ? "" : "s"}.`,
    );
  }

  const minor = Number(whole + fraction.padEnd(exponent, "0"));
  if (!Number.isSafeInteger(minor)) throw new MoneyError("Amount is too large.");
  return minor;
}

// Formats minor units for display, for example "$1,234.50" or "¥1,234".
// Negative values are formatted with a leading minus sign.
export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  const code = normalizeCurrency(currency);
  const exponent = currencyExponent(code);
  if (!Number.isSafeInteger(minor)) throw new MoneyError("Amount must be a whole number of minor units.");
  const major = minor / 10 ** exponent;
  return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(major);
}
