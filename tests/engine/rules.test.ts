// Unit tests: sequence rules, payment plan validation, dedupe keys and the
// sender profile rule. No database.
import { describe, expect, it } from "vitest";
import { defaultRequiresApproval, orderSteps, validateSequence } from "@/lib/engine/sequence";
import { validateInstallments } from "@/lib/engine/installments";
import { planDedupeKey, standardDedupeKey } from "@/lib/engine/dedupe";
import { settingsProfileComplete } from "@/lib/engine/profile";

const INV = "11111111-1111-4111-8111-111111111111";
const STEP = "22222222-2222-4222-8222-222222222222";
const INST = "33333333-3333-4333-8333-333333333333";

describe("sequence rules", () => {
  it("requires approval above 14 days and for any final notice, by default", () => {
    expect(defaultRequiresApproval(15, false)).toBe(true);
    expect(defaultRequiresApproval(14, false)).toBe(false);
    expect(defaultRequiresApproval(-3, false)).toBe(false);
    expect(defaultRequiresApproval(0, true)).toBe(true);
  });

  it("orders by offset and keeps list order for equal offsets", () => {
    const ordered = orderSteps([
      { offsetDays: 7, isFinalNotice: false, tag: "a" },
      { offsetDays: 0, isFinalNotice: false, tag: "b" },
      { offsetDays: 7, isFinalNotice: false, tag: "c" },
      { offsetDays: -3, isFinalNotice: false, tag: "d" },
    ]);
    expect(ordered.map((s) => s.tag)).toEqual(["d", "b", "a", "c"]);
  });

  it("accepts a final notice that is last", () => {
    expect(validateSequence([{ offsetDays: 0, isFinalNotice: false }, { offsetDays: 14, isFinalNotice: true }]).ok).toBe(true);
  });

  it("rejects a step after the final notice", () => {
    const result = validateSequence([
      { offsetDays: 14, isFinalNotice: true },
      { offsetDays: 21, isFinalNotice: false },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects a final notice that is not last in send order, even if listed last", () => {
    // Offset 3 sorts before offset 7, so the final notice at 3 is not the last step sent.
    const result = validateSequence([
      { offsetDays: 7, isFinalNotice: false },
      { offsetDays: 3, isFinalNotice: true },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects fractional offsets", () => {
    expect(validateSequence([{ offsetDays: 1.5, isFinalNotice: false }]).ok).toBe(false);
  });
});

describe("payment plan validation", () => {
  const total = 100000;

  it("accepts two or more installments that sum exactly and have increasing dates", () => {
    expect(
      validateInstallments(total, [
        { dueDate: "2026-12-01", amountMinor: 50000 },
        { dueDate: "2027-01-01", amountMinor: 50000 },
      ]).ok,
    ).toBe(true);
  });

  it("rejects fewer than two installments", () => {
    const result = validateInstallments(total, [{ dueDate: "2026-12-01", amountMinor: total }]);
    expect(result.ok).toBe(false);
  });

  it("rejects amounts that do not sum exactly to the invoice", () => {
    const result = validateInstallments(total, [
      { dueDate: "2026-12-01", amountMinor: 50000 },
      { dueDate: "2027-01-01", amountMinor: 49999 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects dates that do not strictly increase", () => {
    const equal = validateInstallments(total, [
      { dueDate: "2026-12-01", amountMinor: 50000 },
      { dueDate: "2026-12-01", amountMinor: 50000 },
    ]);
    const backwards = validateInstallments(total, [
      { dueDate: "2027-01-01", amountMinor: 50000 },
      { dueDate: "2026-12-01", amountMinor: 50000 },
    ]);
    expect(equal.ok).toBe(false);
    expect(backwards.ok).toBe(false);
  });

  it("rejects non-positive and malformed installments", () => {
    expect(validateInstallments(total, [
      { dueDate: "2026-12-01", amountMinor: 0 },
      { dueDate: "2027-01-01", amountMinor: total },
    ]).ok).toBe(false);
    expect(validateInstallments(total, [
      { dueDate: "01/12/2026", amountMinor: 50000 },
      { dueDate: "2027-01-01", amountMinor: 50000 },
    ]).ok).toBe(false);
  });
});

describe("dedupe keys", () => {
  it("builds invoice:step for a standard step and installment:step for a plan step", () => {
    expect(standardDedupeKey(INV, STEP)).toBe(`${INV}:${STEP}`);
    expect(planDedupeKey(INST, STEP)).toBe(`${INST}:${STEP}`);
  });

  it("is stable for the same inputs", () => {
    expect(standardDedupeKey(INV, STEP)).toBe(standardDedupeKey(INV, STEP));
  });
});

describe("sender profile rule", () => {
  const full = { sender_name: "Ada", business_name: "Ada Studio", postal_address: "1 Main St" };

  it("is complete when all three fields are filled", () => {
    expect(settingsProfileComplete(full)).toBe(true);
  });

  it("is incomplete when any field is blank or whitespace", () => {
    expect(settingsProfileComplete({ ...full, sender_name: "" })).toBe(false);
    expect(settingsProfileComplete({ ...full, business_name: "   " })).toBe(false);
    expect(settingsProfileComplete({ ...full, postal_address: "" })).toBe(false);
  });
});
