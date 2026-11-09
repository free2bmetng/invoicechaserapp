import { describe, expect, it } from "vitest";
import { MoneyError, currencyExponent, formatMoney, parseMoneyToMinor } from "@/lib/money";

// Intl separates some groups with NBSP. Normalize so tests compare visible text.
const visible = (s: string) => s.replace(/\s/g, " ");

describe("parseMoneyToMinor", () => {
  it("converts plain decimals to integer minor units", () => {
    expect(parseMoneyToMinor("1234.5", "USD")).toBe(123450);
    expect(parseMoneyToMinor("1234.50", "USD")).toBe(123450);
    expect(parseMoneyToMinor("1234", "USD")).toBe(123400);
    expect(parseMoneyToMinor("0.01", "USD")).toBe(1);
    expect(parseMoneyToMinor(".5", "USD")).toBe(50);
    expect(parseMoneyToMinor("0", "USD")).toBe(0);
    expect(parseMoneyToMinor("0.00", "USD")).toBe(0);
  });

  it("avoids binary floating point errors", () => {
    // 0.29 * 100 is 28.999999999999996 in floating point, so truncating it would be wrong.
    expect(parseMoneyToMinor("0.29", "USD")).toBe(29);
    expect(parseMoneyToMinor("19.99", "USD")).toBe(1999);
    expect(parseMoneyToMinor("1.10", "EUR")).toBe(110);
  });

  it("ignores surrounding whitespace and accepts lower-case currency codes", () => {
    expect(parseMoneyToMinor("  12.50 ", "USD")).toBe(1250);
    expect(parseMoneyToMinor("12.50", "usd")).toBe(1250);
  });

  it("uses the currency's minor units: JPY 0, USD 2, BHD 3", () => {
    expect(parseMoneyToMinor("1234", "JPY")).toBe(1234);
    expect(parseMoneyToMinor("1.234", "BHD")).toBe(1234);
    // "1.23" is 1.230 dinars: BHD has three minor digits, so the amount is 1230.
    expect(parseMoneyToMinor("1.23", "BHD")).toBe(1230);
  });

  it("rejects more decimal places than the currency allows", () => {
    expect(() => parseMoneyToMinor("1234.5", "JPY")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("1234.0", "JPY")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("12.345", "USD")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("1.2345", "BHD")).toThrow(MoneyError);
  });

  it("rejects negative amounts", () => {
    expect(() => parseMoneyToMinor("-1", "USD")).toThrow(/negative/);
    expect(() => parseMoneyToMinor("-0.50", "USD")).toThrow(/negative/);
  });

  it.each(["NaN", "Infinity", "-Infinity", "1e3", "+5", "abc", "$12.00", "12.5.0", "1.", ".", "   ", ""])(
    "rejects %j as not a plain decimal",
    (input) => {
      expect(() => parseMoneyToMinor(input, "USD")).toThrow(MoneyError);
    },
  );

  it.each(["1,234.50", "1.234,50", "1 234", "1_000", "1'000.00", "12,50"])(
    "rejects thousands separators and other decimal marks: %j",
    (input) => {
      expect(() => parseMoneyToMinor(input, "USD")).toThrow(MoneyError);
    },
  );

  it("rejects non-string input", () => {
    expect(() => parseMoneyToMinor(12.5 as unknown as string, "USD")).toThrow(MoneyError);
  });

  it("rejects unknown currency codes", () => {
    expect(() => parseMoneyToMinor("1", "XYZ")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("1", "")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("1", "US")).toThrow(MoneyError);
  });

  it("accepts the largest safe amount and rejects anything past it", () => {
    expect(parseMoneyToMinor("9007199254740.99", "USD")).toBe(900719925474099);
    expect(() => parseMoneyToMinor("9007199254740992", "USD")).toThrow(/too large/);
  });
});

describe("currencyExponent", () => {
  it("reads the minor-unit count from Intl", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("usd")).toBe(2);
  });

  it("throws for an unknown code", () => {
    expect(() => currencyExponent("ZZZ")).toThrow(MoneyError);
  });
});

describe("formatMoney", () => {
  it("formats with grouping and two decimals for USD", () => {
    expect(formatMoney(123450, "USD")).toBe("$1,234.50");
    expect(formatMoney(0, "USD")).toBe("$0.00");
    expect(formatMoney(5, "USD")).toBe("$0.05");
  });

  it("formats negative values with a leading minus sign", () => {
    expect(formatMoney(-500, "USD")).toBe("-$5.00");
  });

  it("uses no decimals for JPY", () => {
    expect(formatMoney(1234, "JPY")).toBe("¥1,234");
  });

  it("uses three decimals for BHD", () => {
    expect(visible(formatMoney(1234, "BHD"))).toBe("BHD 1.234");
  });

  it("follows the requested locale", () => {
    expect(visible(formatMoney(123450, "EUR", "de-DE"))).toBe("1.234,50 €");
  });

  it("is the inverse of parseMoneyToMinor for the same currency", () => {
    expect(formatMoney(parseMoneyToMinor("19.99", "USD"), "USD")).toBe("$19.99");
  });

  it("rejects non-integer and unsafe minor amounts", () => {
    expect(() => formatMoney(1.5, "USD")).toThrow(MoneyError);
    expect(() => formatMoney(Number.NaN, "USD")).toThrow(MoneyError);
    expect(() => formatMoney(2 ** 60, "USD")).toThrow(MoneyError);
  });

  it("rejects unknown currency codes", () => {
    expect(() => formatMoney(100, "ZZZ")).toThrow(MoneyError);
  });
});
