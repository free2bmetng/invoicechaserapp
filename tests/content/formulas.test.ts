import { describe, expect, it } from "vitest";
import { csvSafeCell } from "@/lib/formulas";

describe("csvSafeCell", () => {
  it.each([
    ["=HYPERLINK(\"https://evil.example.test\")", "'=HYPERLINK(\"https://evil.example.test\")"],
    ["+1+1", "'+1+1"],
    ["-5.00", "'-5.00"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", "'\rcmd"],
  ])("prefixes an apostrophe to %j", (input, expected) => {
    expect(csvSafeCell(input)).toBe(expected);
  });

  it.each([
    ["Acme Ltd"],
    ["1234"],
    ["2026-11-08"],
    ["a=b"],
    ["x-y"],
    ["user@example.test"],
    ["INV-1042"],
    [""],
    [" =leading space"],
    ["'=already escaped"],
  ])("leaves %j unchanged", (input) => {
    expect(csvSafeCell(input)).toBe(input);
  });

  it("escapes only once, based on the first character", () => {
    expect(csvSafeCell("=1")).toBe("'=1");
    expect(csvSafeCell("'=1")).toBe("'=1");
  });

  it("leaves a newline-led value unchanged, as the rule covers tab and carriage return only", () => {
    expect(csvSafeCell("\nnext")).toBe("\nnext");
  });
});
