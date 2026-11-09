// Pure settings rules: no database. These are the checks the forms and the server actions share.
import { describe, expect, it } from "vitest";
import {
  checkDailyCap,
  checkDigestHour,
  checkProfileAndSettings,
  checkRestrictedKey,
  checkSendingDomain,
  checkSendWindow,
  checkSenderProfile,
  checkTimezone,
  normalizeDomain,
  timeZoneOptions,
  type ProfileAndSettingsRaw,
} from "@/components/settings/rules";
import { emailConfirmationMatches } from "@/lib/account";

function errorsOf(result: { ok: boolean; errors?: Record<string, string> }): Record<string, string> {
  if (result.ok || !result.errors) throw new Error("expected a refusal");
  return result.errors;
}

describe("sender profile", () => {
  it("accepts trimmed values and keeps the address line breaks", () => {
    const result = checkSenderProfile({
      senderName: "  Ada Lovelace ",
      businessName: "Ada Studio Ltd",
      postalAddress: "  1 Harbour Road \r\n\r\n Bristol BS1 4XY  ",
    });
    expect(result).toEqual({
      ok: true,
      value: { senderName: "Ada Lovelace", businessName: "Ada Studio Ltd", postalAddress: "1 Harbour Road\nBristol BS1 4XY" },
    });
  });

  it("refuses each empty field under its own key", () => {
    const errors = errorsOf(checkSenderProfile({ senderName: "  ", businessName: "", postalAddress: undefined }));
    expect(Object.keys(errors).sort()).toEqual(["businessName", "postalAddress", "senderName"]);
  });

  it("refuses a name that spans lines or contains a tab", () => {
    expect(errorsOf(checkSenderProfile({ senderName: "Ada\nLovelace", businessName: "B", postalAddress: "x" })).senderName).toBeDefined();
    expect(errorsOf(checkSenderProfile({ senderName: "Ada\tL", businessName: "B", postalAddress: "x" })).senderName).toBeDefined();
  });

  it("refuses a tab inside the address but allows line breaks", () => {
    expect(errorsOf(checkSenderProfile({ senderName: "A", businessName: "B", postalAddress: "a\tb" })).postalAddress).toBeDefined();
    expect(checkSenderProfile({ senderName: "A", businessName: "B", postalAddress: "a\nb" }).ok).toBe(true);
  });

  it("refuses over-long values", () => {
    const long = "x".repeat(101);
    expect(errorsOf(checkSenderProfile({ senderName: long, businessName: "B", postalAddress: "x" })).senderName).toBeDefined();
    expect(errorsOf(checkSenderProfile({ senderName: "A", businessName: "B", postalAddress: "x".repeat(401) })).postalAddress).toBeDefined();
  });
});

describe("timezone", () => {
  it("accepts IANA zones and UTC", () => {
    expect(checkTimezone("Europe/London")).toEqual({ ok: true, value: "Europe/London" });
    expect(checkTimezone("UTC")).toEqual({ ok: true, value: "UTC" });
  });

  it("refuses unknown, wrongly cased and empty zones", () => {
    expect(errorsOf(checkTimezone("Mars/Olympus")).timezone).toBeDefined();
    expect(errorsOf(checkTimezone("europe/london")).timezone).toBeDefined();
    expect(errorsOf(checkTimezone("   ")).timezone).toBeDefined();
  });

  it("offers every zone the runtime knows, plus UTC, once", () => {
    const options = timeZoneOptions();
    expect(options).toContain("Europe/London");
    expect(options).toContain("UTC");
    expect(new Set(options).size).toBe(options.length);
  });
});

describe("send window", () => {
  it("accepts the full 09:00-17:00 range and any narrowing inside it", () => {
    expect(checkSendWindow("9", "17")).toEqual({ ok: true, value: { start: 9, end: 17 } });
    expect(checkSendWindow("09", "10")).toEqual({ ok: true, value: { start: 9, end: 10 } });
    expect(checkSendWindow("16", "17")).toEqual({ ok: true, value: { start: 16, end: 17 } });
  });

  it("refuses starts before 09:00 and after 16:00", () => {
    expect(errorsOf(checkSendWindow("8", "17")).windowStart).toBeDefined();
    expect(errorsOf(checkSendWindow("17", "17")).windowStart).toBeDefined();
  });

  it("refuses ends before 10:00 and after 17:00, so the window can never widen", () => {
    expect(errorsOf(checkSendWindow("9", "9")).windowEnd).toBeDefined();
    expect(errorsOf(checkSendWindow("9", "18")).windowEnd).toBeDefined();
  });

  it("refuses an end that is not after the start", () => {
    expect(errorsOf(checkSendWindow("12", "12")).windowEnd).toBe("The window must end after it starts.");
  });

  it("refuses values that are not whole hours", () => {
    expect(errorsOf(checkSendWindow("9.5", "17")).windowStart).toBeDefined();
    expect(errorsOf(checkSendWindow("", "")).windowStart).toBeDefined();
    expect(errorsOf(checkSendWindow("-1", "17")).windowStart).toBeDefined();
  });
});

describe("daily cap", () => {
  it("accepts whole numbers from 1 to 500", () => {
    expect(checkDailyCap("1")).toEqual({ ok: true, value: 1 });
    expect(checkDailyCap(" 500 ")).toEqual({ ok: true, value: 500 });
    expect(checkDailyCap("20")).toEqual({ ok: true, value: 20 });
  });

  it("refuses 0, 501, decimals, exponents and blanks", () => {
    for (const bad of ["0", "501", "20.5", "1e2", "", "twenty", "-3"]) {
      expect(errorsOf(checkDailyCap(bad)).dailyCap).toBeDefined();
    }
  });
});

describe("digest hour", () => {
  it("accepts 00 to 23", () => {
    expect(checkDigestHour("0")).toEqual({ ok: true, value: 0 });
    expect(checkDigestHour("23")).toEqual({ ok: true, value: 23 });
    expect(checkDigestHour("08")).toEqual({ ok: true, value: 8 });
  });

  it("refuses 24, negative numbers and words", () => {
    expect(errorsOf(checkDigestHour("24")).digestHour).toBeDefined();
    expect(errorsOf(checkDigestHour("-1")).digestHour).toBeDefined();
    expect(errorsOf(checkDigestHour("noon")).digestHour).toBeDefined();
  });
});

describe("sending domain", () => {
  it("lower-cases the domain and drops a trailing dot", () => {
    expect(normalizeDomain("Yourbusiness.COM.")).toBe("yourbusiness.com");
    expect(checkSendingDomain("Mail.Example.co.uk")).toEqual({ ok: true, value: "mail.example.co.uk" });
  });

  it("refuses URLs, email addresses and paths", () => {
    expect(errorsOf(checkSendingDomain("https://yourbusiness.com")).sendingDomain).toBeDefined();
    expect(errorsOf(checkSendingDomain("ada@yourbusiness.com")).sendingDomain).toBeDefined();
    expect(errorsOf(checkSendingDomain("yourbusiness.com/mail")).sendingDomain).toBeDefined();
  });

  it("refuses names that are not domains", () => {
    expect(errorsOf(checkSendingDomain("localhost")).sendingDomain).toBeDefined();
    expect(errorsOf(checkSendingDomain("-bad.example.com")).sendingDomain).toBeDefined();
    expect(errorsOf(checkSendingDomain("x")).sendingDomain).toBeDefined();
    expect(errorsOf(checkSendingDomain("")).sendingDomain).toBeDefined();
  });

  it("refuses free mail domains, because reminders must come from a domain the user controls", () => {
    expect(errorsOf(checkSendingDomain("gmail.com")).sendingDomain).toMatch(/Use a domain you own/);
    expect(errorsOf(checkSendingDomain("Outlook.com")).sendingDomain).toMatch(/Use a domain you own/);
  });
});

describe("restricted Stripe key", () => {
  it("accepts a restricted key", () => {
    expect(checkRestrictedKey("rk_live_abcdef123456")).toEqual({ ok: true, value: "rk_live_abcdef123456" });
  });

  it("refuses secret keys, short keys, keys with spaces and blanks", () => {
    expect(errorsOf(checkRestrictedKey("sk_live_abcdef123456")).stripeKey).toMatch(/sk_/);
    expect(errorsOf(checkRestrictedKey("rk_short")).stripeKey).toBeDefined();
    expect(errorsOf(checkRestrictedKey("rk_live_abc def123456")).stripeKey).toBeDefined();
    expect(errorsOf(checkRestrictedKey("")).stripeKey).toBeDefined();
  });
});

describe("onboarding step 1 check", () => {
  const valid: ProfileAndSettingsRaw = {
    senderName: "Ada",
    businessName: "Ada Studio",
    postalAddress: "1 Main St",
    timezone: "Europe/London",
    windowStart: "9",
    windowEnd: "17",
    dailyCap: "20",
    digestEnabled: true,
    digestHour: "8",
  };

  it("returns every value in one object when all fields are valid", () => {
    expect(checkProfileAndSettings(valid)).toEqual({
      ok: true,
      value: {
        senderName: "Ada",
        businessName: "Ada Studio",
        postalAddress: "1 Main St",
        timezone: "Europe/London",
        windowStart: 9,
        windowEnd: 17,
        dailyCap: 20,
        digestEnabled: true,
        digestHour: 8,
      },
    });
  });

  it("reports the errors from every part at once, each under its own field", () => {
    const errors = errorsOf(
      checkProfileAndSettings({ ...valid, senderName: "", timezone: "Nowhere/Land", dailyCap: "0", windowEnd: "18" }),
    );
    expect(Object.keys(errors).sort()).toEqual(["dailyCap", "senderName", "timezone", "windowEnd"]);
  });
});

describe("confirmation of the account email", () => {
  it("matches only the exact address, ignoring surrounding whitespace", () => {
    expect(emailConfirmationMatches("ada@example.test", "ada@example.test")).toBe(true);
    expect(emailConfirmationMatches("  ada@example.test ", "ada@example.test")).toBe(true);
  });

  it("refuses a different case, a different address, blanks and non-strings", () => {
    expect(emailConfirmationMatches("Ada@example.test", "ada@example.test")).toBe(false);
    expect(emailConfirmationMatches("bob@example.test", "ada@example.test")).toBe(false);
    expect(emailConfirmationMatches("", "")).toBe(false);
    expect(emailConfirmationMatches(undefined, "ada@example.test")).toBe(false);
    expect(emailConfirmationMatches(["ada@example.test"], "ada@example.test")).toBe(false);
  });
});
