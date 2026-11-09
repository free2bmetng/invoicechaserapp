// Unit tests: send window edges, timezones, DST and planned times. No database.
import { describe, expect, it } from "vitest";
import {
  isInsideWindow,
  nextWindowOpening,
  plannedAtFor,
  startOfNextLocalDay,
  localDateString,
} from "@/lib/engine/window";
import { InvalidTimezoneError } from "@/lib/engine/errors";

const at = (iso: string) => new Date(iso);

describe("isInsideWindow (09:00-17:00, start inclusive, end exclusive)", () => {
  it("includes exactly 09:00 and excludes 08:59:59.999", () => {
    expect(isInsideWindow(at("2026-11-10T09:00:00.000Z"), "UTC", 9, 17)).toBe(true);
    expect(isInsideWindow(at("2026-11-10T08:59:59.999Z"), "UTC", 9, 17)).toBe(false);
  });

  it("includes 16:59:59.999 and excludes exactly 17:00", () => {
    expect(isInsideWindow(at("2026-11-10T16:59:59.999Z"), "UTC", 9, 17)).toBe(true);
    expect(isInsideWindow(at("2026-11-10T17:00:00.000Z"), "UTC", 9, 17)).toBe(false);
  });

  it("judges the window in the client's timezone, not UTC", () => {
    // 13:30 UTC is 09:30 in New York during EDT (July): inside.
    expect(isInsideWindow(at("2026-07-01T13:30:00Z"), "America/New_York", 9, 17)).toBe(true);
    // 13:30 UTC is 08:30 in New York during EST (January): outside.
    expect(isInsideWindow(at("2026-01-15T13:30:00Z"), "America/New_York", 9, 17)).toBe(false);
  });

  it("handles a half-hour offset zone", () => {
    expect(isInsideWindow(at("2026-11-10T03:30:00Z"), "Asia/Kolkata", 9, 17)).toBe(true);
    expect(isInsideWindow(at("2026-11-10T03:29:59.999Z"), "Asia/Kolkata", 9, 17)).toBe(false);
  });

  it("honours a narrowed window", () => {
    expect(isInsideWindow(at("2026-11-10T10:00:00Z"), "UTC", 10, 12)).toBe(true);
    expect(isInsideWindow(at("2026-11-10T12:00:00Z"), "UTC", 10, 12)).toBe(false);
  });

  it("rejects an unknown timezone instead of guessing", () => {
    expect(() => isInsideWindow(at("2026-11-10T12:00:00Z"), "Mars/Olympus", 9, 17)).toThrow(InvalidTimezoneError);
  });
});

describe("nextWindowOpening", () => {
  it("returns the instant itself when it is already inside", () => {
    const now = at("2026-11-10T12:00:00Z");
    expect(nextWindowOpening(now, "UTC", 9, 17).getTime()).toBe(now.getTime());
  });

  it("returns 09:00 the same day when called before the window opens", () => {
    expect(nextWindowOpening(at("2026-11-10T08:00:00Z"), "UTC", 9, 17).toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("returns 09:00 the next day at exactly 17:00, because the end is exclusive", () => {
    expect(nextWindowOpening(at("2026-11-10T17:00:00Z"), "UTC", 9, 17).toISOString()).toBe("2026-11-11T09:00:00.000Z");
  });

  it("returns 09:00 the next day when called late in the evening", () => {
    expect(nextWindowOpening(at("2026-11-10T23:45:00Z"), "UTC", 9, 17).toISOString()).toBe("2026-11-11T09:00:00.000Z");
  });

  it("opens at the client's 09:00, which can fall on a different UTC date", () => {
    // Auckland is UTC+13 (NZDT) on 2026-11-11: 21:00 UTC on the 10th is 10:00 on the 11th, inside.
    const inside = nextWindowOpening(at("2026-11-10T21:00:00Z"), "Pacific/Auckland", 9, 17);
    expect(inside.toISOString()).toBe("2026-11-10T21:00:00.000Z");
    // 2026-11-10 12:00 UTC is 01:00 on the 11th in Auckland: next opening is 09:00 that day (20:00 UTC).
    const later = nextWindowOpening(at("2026-11-10T12:00:00Z"), "Pacific/Auckland", 9, 17);
    expect(later.toISOString()).toBe("2026-11-10T20:00:00.000Z");
  });

  it("uses the narrowed window when deciding the next opening", () => {
    expect(nextWindowOpening(at("2026-11-10T09:30:00Z"), "UTC", 10, 12).toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect(nextWindowOpening(at("2026-11-10T12:00:00Z"), "UTC", 10, 12).toISOString()).toBe("2026-11-11T10:00:00.000Z");
  });

  it("stays on the local 09:00 across the US spring-forward day", () => {
    // 2026-03-08 is the US DST start. 09:00 EDT is 13:00 UTC.
    const next = nextWindowOpening(at("2026-03-08T00:00:00-05:00"), "America/New_York", 9, 17);
    expect(next.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("plannedAtFor", () => {
  it("places a step at the window start in the client's timezone", () => {
    // 2026-11-08 minus 3 days, 09:00 in New York (EST, UTC-5).
    expect(plannedAtFor("2026-11-08", -3, "America/New_York", 9).toISOString()).toBe("2026-11-05T14:00:00.000Z");
  });

  it("uses offset zero for the due date itself", () => {
    expect(plannedAtFor("2026-11-08", 0, "UTC", 9).toISOString()).toBe("2026-11-08T09:00:00.000Z");
  });

  it("adds calendar days across a DST change without drifting the local time", () => {
    // 2026-03-07 plus 1 day lands on 2026-03-08, 09:00 EDT (UTC-4).
    expect(plannedAtFor("2026-03-07", 1, "America/New_York", 9).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("handles offsets of +7 and +14", () => {
    expect(plannedAtFor("2026-11-08", 7, "UTC", 9).toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect(plannedAtFor("2026-11-08", 14, "UTC", 9).toISOString()).toBe("2026-11-22T09:00:00.000Z");
  });
});

describe("local day helpers", () => {
  it("returns the next local midnight, which is not the next UTC midnight", () => {
    // 2026-11-10 20:00 UTC is 15:00 on the 10th in New York; next local midnight is 2026-11-11 05:00 UTC.
    expect(startOfNextLocalDay(at("2026-11-10T20:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("returns the calendar date in the given timezone", () => {
    expect(localDateString(at("2026-11-10T03:00:00Z"), "America/New_York")).toBe("2026-11-09");
    expect(localDateString(at("2026-11-10T03:00:00Z"), "UTC")).toBe("2026-11-10");
  });
});
