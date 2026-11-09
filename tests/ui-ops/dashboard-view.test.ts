// The dashboard client table's empty cells. DESIGN_V2 replaces the old single dash with an empty
// cell (null), which the shared Table hides on phone, so there are no bare dashes.
import { describe, expect, it } from "vitest";
import { lastContactText, paymentPatternCell } from "@/components/ops/dashboard-view";

describe("empty cells on the dashboard clients table", () => {
  it("leaves the payment pattern empty when the client has no paid invoice", () => {
    expect(paymentPatternCell(null, null)).toEqual({ headline: null, secondary: null });
  });

  it("shows the pattern, and the average from the issue date as the secondary line", () => {
    expect(paymentPatternCell(10, 40)).toEqual({ headline: "Typically pays 10 days late", secondary: "Average 40 days to pay" });
    expect(paymentPatternCell(-2, 9)).toEqual({ headline: "Paid early", secondary: "Average 9 days to pay" });
  });

  it("leaves last contact empty when there has been no contact", () => {
    expect(lastContactText(null, "UTC")).toBeNull();
  });

  it("shows the date of the last contact in the user's timezone", () => {
    expect(lastContactText(new Date("2026-11-09T12:00:00Z"), "UTC")).toBe("9 Nov 2026");
  });
});
