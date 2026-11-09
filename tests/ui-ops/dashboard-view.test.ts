// The dashboard client table's dash rules. A single dash replaces the filler for a client with no
// paid invoice, and for a client with no contact.
import { describe, expect, it } from "vitest";
import { lastContactText, paymentPatternCell } from "@/components/ops/dashboard-view";

describe("dash rules on the dashboard clients table", () => {
  it("shows a single dash for the payment pattern when the client has no paid invoice", () => {
    expect(paymentPatternCell(null, null)).toEqual({ headline: "–", secondary: null });
  });

  it("shows the pattern, and the average from the issue date as the secondary line", () => {
    expect(paymentPatternCell(10, 40)).toEqual({ headline: "Typically pays 10 days late", secondary: "Average 40 days to pay" });
    expect(paymentPatternCell(-2, 9)).toEqual({ headline: "Paid early", secondary: "Average 9 days to pay" });
  });

  it("shows a single dash for last contact when there has been no contact", () => {
    expect(lastContactText(null, "UTC")).toBe("–");
  });

  it("shows the date of the last contact in the user's timezone", () => {
    expect(lastContactText(new Date("2026-11-09T12:00:00Z"), "UTC")).toBe("9 Nov 2026");
  });
});
