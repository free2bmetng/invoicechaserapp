// Pure display and rule helpers for the records screens: money inputs, plain-English messages,
// step ordering and the final-notice rule, form-state helpers. No database.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVENT_LABELS, INVOICE_STATUS_LABEL, STATUS_CONTROLS, daysBetween, describeNextMessage, describeOffset, eventLabel, isOverdue, minorToInput, dayLabelFor, lateLabel,
} from "@/components/invoices/format";
import { isUuidText, listValue, valuesFrom, zodFieldErrors } from "@/components/invoices/form-state";
import {
  defaultApproval, isFinalMisplaced, isPresetTone, lastKeyOf, newDraft, ordinal, parseOffset, presetText, sendOrder, timingText, type DraftStep,
} from "@/components/sequences/state";
import { TONE_PRESETS } from "@/lib/templates";

function draft(key: string, offsetText: string, extra: Partial<DraftStep> = {}): DraftStep {
  return { ...newDraft(key, 0), key, offsetText, ...extra };
}

describe("money inputs", () => {
  it("writes minor units back as the decimal text a user types, per currency", () => {
    expect(minorToInput(125000, "USD")).toBe("1250.00");
    expect(minorToInput(5, "USD")).toBe("0.05");
    expect(minorToInput(1234, "JPY")).toBe("1234");
    expect(minorToInput(1234500, "BHD")).toBe("1234.500");
  });
});

describe("next message in plain English", () => {
  const base = { zone: "UTC", profileComplete: true, onboardingDone: true };

  it("says an invoice created before setup finishes is waiting for setup, not blank", () => {
    expect(describeNextMessage({ ...base, onboardingDone: false, invoiceStatus: "open", next: null })).toBe("Waiting for setup to finish.");
  });

  it("explains each stop status without a next message", () => {
    expect(describeNextMessage({ ...base, invoiceStatus: "paid", next: null })).toBe("Paid. No reminders are sent.");
    expect(describeNextMessage({ ...base, invoiceStatus: "written_off", next: null })).toBe("Written off. Nothing more is sent.");
    expect(describeNextMessage({ ...base, invoiceStatus: "paused", next: null })).toMatch(/Paused\./);
    expect(describeNextMessage({ ...base, invoiceStatus: "disputed", next: null })).toMatch(/Disputed\./);
  });

  it("says what is waiting, and when", () => {
    const next = { status: "pending_approval", plannedAt: "2027-06-08T09:00:00.000Z", requiresApproval: true };
    expect(describeNextMessage({ ...base, invoiceStatus: "open", next })).toMatch(/waiting for your approval/);
    expect(describeNextMessage({ ...base, invoiceStatus: "open", next: { ...next, status: "scheduled" } })).toMatch(/^Next reminder /);
    expect(describeNextMessage({ ...base, invoiceStatus: "open", next: { ...next, status: "held" } })).toBe("A reminder is on hold.");
    expect(describeNextMessage({ ...base, invoiceStatus: "open", next: null })).toBe("No reminders left to send.");
  });

  it("asks for the sender profile when it is incomplete", () => {
    expect(describeNextMessage({ ...base, profileComplete: false, invoiceStatus: "open", next: null })).toMatch(/sender profile/);
  });
});

describe("status controls and labels", () => {
  it("marks every control that stops everything, and only those", () => {
    const stops = STATUS_CONTROLS.filter((c) => c.stopsEverything).map((c) => c.status);
    expect(stops.sort()).toEqual(["disputed", "paid", "paused", "written_off"]);
    expect(INVOICE_STATUS_LABEL.payment_plan).toBe("Payment plan");
  });

  it("names both statuses in a status-change event", () => {
    expect(eventLabel("status_changed", { from: "open", to: "paused" })).toBe("Status changed from Open to Paused");
    expect(eventLabel("message_bounced", {})).toBe(EVENT_LABELS.message_bounced);
    expect(eventLabel("some_new_event", {})).toBe("Some new event");
  });
});

describe("payment timing", () => {
  it("says how late a client typically pays, and that a negative figure is early", () => {
    expect(lateLabel(4.2)).toBe("4 days late");
    expect(lateLabel(1)).toBe("1 day late");
    expect(lateLabel(-3.5)).toBe("Paid early");
    expect(lateLabel(0.2)).toBe("On time");
    expect(lateLabel(null)).toBeNull();
  });
});

describe("dates and offsets", () => {
  it("describes offsets in whole days, before or after the anchor", () => {
    expect(describeOffset(-3, "the due date")).toBe("3 days before the due date");
    expect(describeOffset(0, "the due date")).toBe("On the due date");
    expect(describeOffset(1, "the due date")).toBe("1 day after the due date");
    expect(describeOffset(null, "the due date")).toBe("Step removed");
  });

  it("measures overdue days on calendar dates", () => {
    expect(daysBetween("2027-06-15", "2027-06-20")).toBe(5);
    expect(isOverdue("2027-06-15", "2027-06-16")).toBe(true);
    expect(isOverdue("2027-06-15", "2027-06-15")).toBe(false);
  });

  it("formats an instant as a day in the given zone", () => {
    expect(dayLabelFor("2026-11-09T01:30:00.000Z", "America/New_York")).toBe("8 Nov 2026");
    expect(dayLabelFor("2026-11-09T01:30:00.000Z", "UTC")).toBe("9 Nov 2026");
  });
});

describe("sequence steps", () => {
  it("parses only whole-day offsets", () => {
    expect(parseOffset("-3")).toBe(-3);
    expect(parseOffset(" 14 ")).toBe(14);
    expect(parseOffset("1.5")).toBeNull();
    expect(parseOffset("")).toBeNull();
    expect(parseOffset("-")).toBeNull();
    expect(parseOffset("99999")).toBeNull();
  });

  it("ordinals read correctly, including the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });

  it("sends in offset order, and equal offsets keep their list order", () => {
    const drafts = [draft("late", "7"), draft("first", "-3"), draft("tie-a", "0"), draft("tie-b", "0")];
    expect(sendOrder(drafts).map((d) => d.key)).toEqual(["first", "tie-a", "tie-b", "late"]);
    expect(lastKeyOf(drafts)).toBe("late");
  });

  it("flags a final notice that is not the last step in send order", () => {
    const drafts = [draft("final", "0", { isFinalNotice: true }), draft("after", "7")];
    const last = lastKeyOf(drafts);
    expect(isFinalMisplaced(drafts[0], last)).toBe(true);
    expect(isFinalMisplaced(drafts[1], last)).toBe(false);
    const fixed = [draft("final", "14", { isFinalNotice: true }), draft("before", "7")];
    expect(isFinalMisplaced(fixed[0], lastKeyOf(fixed))).toBe(false);
  });

  it("asks for approval above 14 days and for every final notice, as the engine does", () => {
    expect(defaultApproval(15, false)).toBe(true);
    expect(defaultApproval(14, false)).toBe(false);
    expect(defaultApproval(3, true)).toBe(true);
    expect(defaultApproval(null, false)).toBe(false);
  });

  it("gives presets their own text and only presets are read-only", () => {
    expect(isPresetTone("firm")).toBe(true);
    expect(isPresetTone("custom")).toBe(false);
    expect(presetText("neutral")).toEqual(TONE_PRESETS.neutral);
    expect(presetText("custom")).toBeNull();
    expect(timingText(null, "plan")).toBe("Enter a whole number of days");
    expect(timingText(0, "plan")).toBe("On the installment due date");
  });
});

describe("form state helpers", () => {
  it("returns zod issues keyed by the field that failed, first message only", () => {
    const parsed = z.object({ name: z.string().min(1, "Enter a name."), amount: z.number() }).safeParse({ name: "", amount: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(zodFieldErrors(parsed.error)).toMatchObject({ name: "Enter a name.", amount: expect.any(String) });
  });

  it("keeps repeated fields as a comma list and reads them back", () => {
    const data = new FormData();
    data.append("ccContactIds", "a");
    data.append("ccContactIds", "b");
    const values = valuesFrom(data, ["ccContactIds", "notes"]);
    expect(values).toEqual({ ccContactIds: "a,b", notes: "" });
    expect(listValue(values, "ccContactIds")).toEqual(["a", "b"]);
    expect(listValue({}, "missing")).toEqual([]);
  });

  it("recognises UUIDs only", () => {
    expect(isUuidText("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuidText("not-a-uuid")).toBe(false);
  });
});
