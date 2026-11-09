// Pure helpers: money rendering, step wording, dates in the user's timezone, cursors and filters.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Money } from "@/components/money";
import { paymentPatternHeadline } from "@/components/ops/kinds";
import { describeStep, formatClock, formatDay, formatPlanned, isUuid, localDay, zoneOrUtc } from "@/lib/queries/ops";
import {
  decodeCursor,
  encodeCursor,
  MESSAGE_LOG_PAGE_SIZE,
  parseMessageLogFilters,
} from "@/lib/queries/messages";

const UUID = "3f1c2a4e-9b8d-4c7e-8a6b-1d2e3f4a5b6c";

describe("Money", () => {
  it("renders minor units with the currency's symbol and tabular figures", () => {
    const html = renderToStaticMarkup(createElement(Money, { minor: 123456, currency: "USD" }));
    expect(html).toContain("$1,234.56");
    expect(html).toContain("num");
  });

  it("uses the currency's own minor units (JPY has none)", () => {
    const html = renderToStaticMarkup(createElement(Money, { minor: 1234, currency: "JPY" }));
    expect(html).toContain("1,234");
    expect(html).not.toContain("12.34");
  });

  it("shows an unknown currency as visible text rather than guessing a format", () => {
    const html = renderToStaticMarkup(createElement(Money, { minor: 500, currency: "XXQ" }));
    expect(html).toContain("XXQ 500 (minor units)");
  });

  it("renders negative amounts with a sign", () => {
    const html = renderToStaticMarkup(createElement(Money, { minor: -250, currency: "EUR" }));
    expect(html).toMatch(/-.*2\.50/);
  });
});

describe("describeStep", () => {
  it("says what a step does relative to the due date", () => {
    expect(describeStep({ hasStep: true, offsetDays: -3, tone: "friendly", isFinalNotice: false, isInstallment: false }))
      .toBe("Friendly reminder, 3 days before the due date");
    expect(describeStep({ hasStep: true, offsetDays: 0, tone: "friendly", isFinalNotice: false, isInstallment: false }))
      .toBe("Friendly reminder, on the due date");
    expect(describeStep({ hasStep: true, offsetDays: 1, tone: "neutral", isFinalNotice: false, isInstallment: false }))
      .toBe("Neutral reminder, 1 day after the due date");
  });

  it("names final notices and installment steps", () => {
    expect(describeStep({ hasStep: true, offsetDays: 14, tone: "firm", isFinalNotice: true, isInstallment: false }))
      .toBe("Final notice, 14 days after the due date");
    expect(describeStep({ hasStep: true, offsetDays: 0, tone: "friendly", isFinalNotice: false, isInstallment: true }))
      .toBe("Friendly reminder, on the installment due date");
  });

  it("handles a step that was removed", () => {
    expect(describeStep({ hasStep: false, offsetDays: null, tone: null, isFinalNotice: null, isInstallment: false }))
      .toBe("Reminder (its step was removed)");
  });
});

describe("dates in the user's timezone", () => {
  // 23:30 UTC on 9 Nov is already 10 Nov in Tokyo.
  const instant = new Date("2026-11-09T23:30:00.000Z");

  it("uses the zone for the calendar day", () => {
    expect(localDay(instant, "UTC")).toBe("2026-11-09");
    expect(localDay(instant, "Asia/Tokyo")).toBe("2026-11-10");
  });

  it("formats days as '8 Nov 2026' and times as 12-hour clock", () => {
    expect(formatDay(instant, "Asia/Tokyo")).toBe("10 Nov 2026");
    expect(formatClock(instant, "Asia/Tokyo")).toBe("8:30 AM");
    expect(formatPlanned(instant, "Asia/Tokyo")).toBe("8:30 AM, Tue 10 Nov");
  });

  it("falls back to UTC for an unknown timezone name", () => {
    expect(zoneOrUtc("Not/AZone")).toBe("UTC");
    expect(zoneOrUtc(null)).toBe("UTC");
    expect(zoneOrUtc("Europe/London")).toBe("Europe/London");
  });

  it("accepts ISO strings as well as Dates", () => {
    expect(formatDay("2026-11-09T12:00:00.000Z", "UTC")).toBe("9 Nov 2026");
  });
});

describe("isUuid", () => {
  it("accepts a UUID and rejects anything else", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(`${UUID}; drop table users`)).toBe(false);
  });
});

describe("message log cursors", () => {
  it("round-trips a Postgres timestamp with microseconds and an id", () => {
    const sentAt = "2030-01-10 10:00:00.123456+00";
    const cursor = encodeCursor(sentAt, UUID);
    expect(decodeCursor(cursor)).toEqual({ sentAt, id: UUID });
  });

  it("rejects malformed, oversized or tampered cursors", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not base64 !!")).toBeNull();
    expect(decodeCursor(Buffer.from("2030-01-10 10:00:00+00|not-a-uuid", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(`'; drop table x;--|${UUID}`, "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor("a".repeat(400))).toBeNull();
  });
});

describe("message log filters", () => {
  it("keeps known statuses and valid client ids only", () => {
    expect(parseMessageLogFilters({ status: "bounced", client: UUID })).toEqual({ status: "bounced", clientId: UUID, cursor: null });
    expect(parseMessageLogFilters({ status: "pending_approval", client: "x" })).toEqual({ status: null, clientId: null, cursor: null });
  });

  it("drops an invalid cursor, so the list starts from the newest message", () => {
    expect(parseMessageLogFilters({ cursor: "garbage" }).cursor).toBeNull();
  });

  it("uses a page size of 50", () => {
    expect(MESSAGE_LOG_PAGE_SIZE).toBe(50);
  });
});

describe("paymentPatternHeadline", () => {
  it("says how late a client typically pays, rounded to whole days", () => {
    expect(paymentPatternHeadline(1)).toBe("Typically pays 1 day late");
    expect(paymentPatternHeadline(12.6)).toBe("Typically pays 13 days late");
    expect(paymentPatternHeadline(4)).toBe("Typically pays 4 days late");
  });

  it("says a client paid early for a negative value, and shows a dash when there is no paid invoice", () => {
    expect(paymentPatternHeadline(-3)).toBe("Paid early");
    expect(paymentPatternHeadline(-0.4)).toBe("Paid early");
    expect(paymentPatternHeadline(null)).toBe("–");
  });

  it("says a client who pays on the due date is on time", () => {
    expect(paymentPatternHeadline(0)).toBe("Typically pays on the due date");
  });
});
