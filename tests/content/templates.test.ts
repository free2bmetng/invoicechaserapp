import { describe, expect, it } from "vitest";
import { MoneyError } from "@/lib/money";
import {
  FOOTER_LINES,
  LATE_PAYMENT_TERMS_SNIPPET,
  MessageError,
  PAY_LINK_PLACEHOLDER,
  PayLinkRequiredError,
  SenderProfileIncompleteError,
  TONE_PRESETS,
  TemplateInvalidError,
  buildMessage,
  isSenderProfileComplete,
  validateTemplate,
  type BuildMessageArgs,
  type SenderProfile,
} from "@/lib/templates";

const SENDER: SenderProfile = {
  senderName: "Jane Doe",
  businessName: "Doe Design",
  postalAddress: "1 Example Street\nLondon EC1A 1AA\nUnited Kingdom",
};

const PAY_URL = "https://pay.example.test/plink_fake_1";

function args(overrides: Partial<BuildMessageArgs> = {}, contextOverrides: Partial<BuildMessageArgs["context"]> = {}): BuildMessageArgs {
  return {
    template: { subject: "Invoice {invoice_number}", body: "Hi {client_name}, pay {amount} by {due_date}." },
    context: {
      clientName: "Acme Ltd",
      invoiceNumber: "INV-1042",
      amountMinor: 123450,
      currency: "USD",
      dueDate: "2026-11-08",
      daysOverdue: 0,
      senderName: SENDER.senderName,
      businessName: SENDER.businessName,
      timezone: "America/New_York",
      payLink: null,
      ...contextOverrides,
    },
    stripeConnected: false,
    sender: SENDER,
    ...overrides,
  };
}

const TENSE_SPECIFIC = /\b(overdue|late|past due|was due|days? (late|overdue)|has passed)\b/i;

describe("TONE_PRESETS", () => {
  it.each(["friendly", "neutral", "firm"] as const)("%s preset passes preset validation", (tone) => {
    expect(validateTemplate(TONE_PRESETS[tone], { preset: true })).toEqual({ ok: true });
    expect(validateTemplate(TONE_PRESETS[tone])).toEqual({ ok: true });
  });

  it.each(["friendly", "neutral", "firm"] as const)("%s preset does not depend on the invoice being overdue", (tone) => {
    const { subject, body } = TONE_PRESETS[tone];
    expect(`${subject}\n${body}`).not.toMatch(TENSE_SPECIFIC);
  });

  it.each(["friendly", "neutral", "firm"] as const)("%s preset renders with no leftover braces when Stripe is off", (tone) => {
    const built = buildMessage(args({ template: TONE_PRESETS[tone], stripeConnected: false }));
    expect(built.subject).not.toMatch(/[{}]/);
    expect(built.text).not.toMatch(/[{}]/);
    expect(built.text).not.toMatch(/pay online/i);
  });

  it.each(["friendly", "neutral", "firm"] as const)("%s preset carries the payment link when Stripe is on", (tone) => {
    const built = buildMessage(args({ template: TONE_PRESETS[tone], stripeConnected: true }, { payLink: PAY_URL }));
    expect(built.text.split(PAY_URL)).toHaveLength(2);
  });

  it("the friendly subject is warm, not a notice", () => {
    expect(TONE_PRESETS.friendly.subject).toBe("Quick note about invoice {invoice_number}");
    expect(TONE_PRESETS.firm.subject).toBe("Invoice {invoice_number}: payment needed");
  });
});

describe("validateTemplate", () => {
  it("accepts a custom template that uses every merge field", () => {
    const result = validateTemplate({
      subject: "{client_name}: {invoice_number} for {amount} {currency}",
      body: "Due {due_date}, {days_overdue} days. {pay_link}\n{sender_name}, {business_name}",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects an unknown token and names it", () => {
    const result = validateTemplate({ subject: "Hi", body: "Balance {balance} is due" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("{balance}");
  });

  it("is case-sensitive about merge field names", () => {
    const result = validateTemplate({ subject: "Hi", body: "Hello {Client_Name}" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown token in the subject", () => {
    const result = validateTemplate({ subject: "{invoice_id}", body: "Hi" });
    expect(result.ok).toBe(false);
  });

  it("rejects {pay_link} in the subject", () => {
    const result = validateTemplate({ subject: "Pay {pay_link}", body: "Hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/only be used in the message body/);
  });

  it("rejects a stray brace that is not part of a field", () => {
    expect(validateTemplate({ subject: "Hi", body: "Hello {client_name" }).ok).toBe(false);
    expect(validateTemplate({ subject: "Hi", body: "Hello }" }).ok).toBe(false);
    expect(validateTemplate({ subject: "Hi", body: "Hello {{client_name}}" }).ok).toBe(false);
  });

  it("reports empty subject and body together", () => {
    const result = validateTemplate({ subject: "  ", body: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  it("rejects a subject that spans lines", () => {
    const result = validateTemplate({ subject: "Line one\nBcc: x@example.test", body: "Hi" });
    expect(result.ok).toBe(false);
  });

  it("rejects control characters in the body but allows tabs, newlines and CRLF", () => {
    expect(validateTemplate({ subject: "Hi", body: "bad\u0000byte" }).ok).toBe(false);
    expect(validateTemplate({ subject: "Hi", body: "col\tcol\r\nnext line" }).ok).toBe(true);
  });

  describe("preset mode", () => {
    it.each([
      ["late fee", "A late fee applies from today."],
      ["late payment charge", "This late payment charge is now due."],
      ["interest", "Interest will be added."],
      ["legal action", "We may take legal action."],
      ["legally", "We can act legally."],
      ["collections", "This may go to collections."],
      ["collection", "This may go to a collection agency."],
      ["penalty", "A penalty will apply."],
      ["court", "This may end up in court."],
      ["lawyer", "I will speak to my lawyer."],
      ["solicitor", "My solicitor will contact you."],
      ["sue", "I may sue for this amount."],
      ["debt collect", "Our debt collector will call."],
    ])("rejects %s in a preset", (_label, sentence) => {
      const result = validateTemplate({ subject: "Invoice {invoice_number}", body: sentence }, { preset: true });
      expect(result.ok).toBe(false);
    });

    it("rejects the wording in the subject too", () => {
      const result = validateTemplate({ subject: "Final notice: legal action", body: "Hi" }, { preset: true });
      expect(result.ok).toBe(false);
    });

    it("does not reject harmless words that contain banned stems", () => {
      const body = "Thank you for the courtesy. I am interested in working with you. Thanks for your feedback.";
      expect(validateTemplate({ subject: "Hi", body }, { preset: true })).toEqual({ ok: true });
    });

    it("allows the same wording in custom text", () => {
      const body = "A late fee of 5% applies, and we may take legal action.";
      expect(validateTemplate({ subject: "Final", body })).toEqual({ ok: true });
    });
  });
});

describe("LATE_PAYMENT_TERMS_SNIPPET", () => {
  it("is generic: it passes the preset wording rules and uses no merge fields", () => {
    expect(validateTemplate({ subject: "Terms", body: LATE_PAYMENT_TERMS_SNIPPET }, { preset: true })).toEqual({ ok: true });
    expect(LATE_PAYMENT_TERMS_SNIPPET).not.toMatch(/[{}]/);
  });
});

describe("isSenderProfileComplete", () => {
  it("requires non-blank sender name, business name and postal address", () => {
    expect(isSenderProfileComplete(SENDER)).toBe(true);
    expect(isSenderProfileComplete({ ...SENDER, senderName: "" })).toBe(false);
    expect(isSenderProfileComplete({ ...SENDER, businessName: "   " })).toBe(false);
    expect(isSenderProfileComplete({ ...SENDER, postalAddress: "\n\t" })).toBe(false);
  });

  it("treats missing or null profiles as incomplete", () => {
    expect(isSenderProfileComplete(null)).toBe(false);
    expect(isSenderProfileComplete(undefined)).toBe(false);
    expect(isSenderProfileComplete({ senderName: "Jane", businessName: "Doe" })).toBe(false);
  });
});

describe("FOOTER_LINES", () => {
  it("is a separator, the name line, then each address line in order", () => {
    expect(FOOTER_LINES(SENDER)).toBe("---\nJane Doe, Doe Design\n1 Example Street\nLondon EC1A 1AA\nUnited Kingdom");
  });

  it("normalizes CRLF addresses and drops blank address lines", () => {
    const footer = FOOTER_LINES({ ...SENDER, postalAddress: "1 Example St\r\n\r\nLondon" });
    expect(footer).toBe("---\nJane Doe, Doe Design\n1 Example St\nLondon");
  });

  it("refuses to build a footer from an incomplete profile", () => {
    expect(() => FOOTER_LINES({ ...SENDER, postalAddress: "" })).toThrow(SenderProfileIncompleteError);
  });
});

describe("buildMessage", () => {
  it("replaces every merge field and formats the amount with formatMoney", () => {
    const built = buildMessage(
      args({
        template: {
          subject: "{client_name}: {invoice_number} {amount} {currency}",
          body: "Hi {client_name}, {invoice_number} is {amount} ({currency}), due {due_date}, {days_overdue} days, from {sender_name} at {business_name}.",
        },
      }, { daysOverdue: 5 }),
    );
    expect(built.subject).toBe("Acme Ltd: INV-1042 $1,234.50 USD");
    expect(built.text.startsWith(
      "Hi Acme Ltd, INV-1042 is $1,234.50 (USD), due 8 Nov 2026, 5 days, from Jane Doe at Doe Design.",
    )).toBe(true);
  });

  it("formats amounts in the currency's minor units (JPY has none)", () => {
    const built = buildMessage(args({ template: { subject: "S", body: "Pay {amount}." } }, { amountMinor: 1234, currency: "JPY" }));
    expect(built.text.startsWith("Pay ¥1,234.")).toBe(true);
  });

  it("renders a calendar date string as written, whatever the client's timezone", () => {
    const built = buildMessage(args({ template: { subject: "S", body: "Due {due_date}." } }, { dueDate: "2026-11-08", timezone: "Pacific/Kiritimati" }));
    expect(built.text.startsWith("Due 8 Nov 2026.")).toBe(true);
  });

  it("renders a Date instant as its date in the client's timezone", () => {
    // 03:00 UTC on 8 Nov is still 7 Nov in Los Angeles and 8 Nov in Tokyo.
    const instant = new Date("2026-11-08T03:00:00Z");
    const la = buildMessage(args({ template: { subject: "S", body: "Due {due_date}." } }, { dueDate: instant, timezone: "America/Los_Angeles" }));
    const tokyo = buildMessage(args({ template: { subject: "S", body: "Due {due_date}." } }, { dueDate: instant, timezone: "Asia/Tokyo" }));
    expect(la.text.startsWith("Due 7 Nov 2026.")).toBe(true);
    expect(tokyo.text.startsWith("Due 8 Nov 2026.")).toBe(true);
  });

  it.each([
    [-3, "0"],
    [0, "0"],
    [5, "5"],
    [2.7, "2"],
  ])("days_overdue %s renders as %s (never negative)", (input, expected) => {
    const built = buildMessage(args({ template: { subject: "S", body: "{days_overdue}" } }, { daysOverdue: input }));
    expect(built.text.startsWith(`${expected}\n`)).toBe(true);
  });

  it("does not re-expand a field value that contains braces", () => {
    const built = buildMessage(args({ template: { subject: "S", body: "Hi {client_name}" } }, { clientName: "{amount}" }));
    expect(built.text.startsWith("Hi {amount}")).toBe(true);
  });

  it("keeps a client name's line breaks out of the subject", () => {
    const built = buildMessage(
      args({ template: { subject: "Invoice for {client_name}", body: "Hi" } }, { clientName: "Acme\r\nBcc: evil@example.test" }),
    );
    expect(built.subject).not.toMatch(/[\r\n]/);
    expect(built.subject).toBe("Invoice for Acme Bcc: evil@example.test");
  });

  describe("payment link", () => {
    it("replaces the {pay_link} token with the URL", () => {
      const built = buildMessage(
        args({ template: { subject: "S", body: "Pay here: {pay_link}" } }, { payLink: PAY_URL }),
        );
      expect(built.text).toContain(`Pay here: ${PAY_URL}`);
      expect(built.text.split(PAY_URL)).toHaveLength(2);
    });

    it("adds a 'Pay online' line before the footer when the template has no token", () => {
      const built = buildMessage(args({ template: { subject: "S", body: "Please pay." } }, { payLink: PAY_URL }));
      const online = built.text.indexOf(`Pay online: ${PAY_URL}`);
      expect(online).toBeGreaterThan(0);
      expect(online).toBeLessThan(built.text.indexOf("---"));
      expect(built.text.endsWith(FOOTER_LINES(SENDER))).toBe(true);
    });

    it("removes every line that contains {pay_link} when there is no link", () => {
      const built = buildMessage(
        args({
          template: { subject: "S", body: "First line.\nYou can pay here: {pay_link}\nLast line." },
        }),
      );
      expect(built.text).not.toContain("{pay_link}");
      expect(built.text).not.toContain("pay here");
      expect(built.text.startsWith("First line.\nLast line.")).toBe(true);
    });

    it("collapses the gap left by a removed pay-link line", () => {
      const built = buildMessage(args({ template: { subject: "S", body: "Hi\n\n{pay_link}\n\nThanks" } }));
      expect(built.text.startsWith("Hi\n\nThanks")).toBe(true);
      expect(built.text).not.toMatch(/\n{3,}/);
    });

    it("throws PayLinkRequiredError when Stripe is connected but no link exists", () => {
      expect(() => buildMessage(args({ stripeConnected: true }))).toThrow(PayLinkRequiredError);
    });

    it("rejects a link that is not a plain http(s) URL", () => {
      for (const bad of ["", "javascript:alert(1)", "https://pay.example.test/a b", "not a url"]) {
        expect(() => buildMessage(args({}, { payLink: bad }))).toThrow(MessageError);
      }
    });

    it("preview shows the placeholder and never throws for a missing link", () => {
      const built = buildMessage(
        args({ template: { subject: "S", body: "Pay: {pay_link}" }, stripeConnected: true, preview: true }),
      );
      expect(built.text).toContain(`Pay: ${PAY_LINK_PLACEHOLDER}`);
    });
  });

  describe("footer and sender profile", () => {
    it("ends every message with the footer, after the body", () => {
      const built = buildMessage(args({ template: { subject: "S", body: "Body text.\n--- not my footer ---" } }));
      expect(built.text.endsWith(FOOTER_LINES(SENDER))).toBe(true);
      expect(built.text).toContain("Jane Doe, Doe Design\n1 Example Street\nLondon EC1A 1AA\nUnited Kingdom");
    });

    it.each([
      ["sender name", { senderName: "" }],
      ["business name", { businessName: "   " }],
      ["postal address", { postalAddress: "" }],
    ])("refuses to build when the %s is missing", (_label, patch) => {
      const incomplete = { ...SENDER, ...patch };
      expect(() => buildMessage(args({ sender: incomplete }, { senderName: incomplete.senderName, businessName: incomplete.businessName }))).toThrow(
        SenderProfileIncompleteError,
      );
    });

    it("refuses when the context names differ from the sender profile", () => {
      expect(() => buildMessage(args({}, { senderName: "Someone Else" }))).toThrow(MessageError);
    });
  });

  describe("input checks", () => {
    it("refuses an invalid template before rendering", () => {
      expect(() => buildMessage(args({ template: { subject: "S", body: "Hi {nope}" } }))).toThrow(TemplateInvalidError);
    });

    it("throws for an unknown timezone", () => {
      expect(() => buildMessage(args({}, { timezone: "Mars/Olympus" }))).toThrow(MessageError);
    });

    it("throws for an unknown currency", () => {
      expect(() => buildMessage(args({}, { currency: "XYZ" }))).toThrow(MoneyError);
    });

    it("throws when the client name is blank", () => {
      expect(() => buildMessage(args({}, { clientName: "   " }))).toThrow(MessageError);
    });

    it("throws when the body is empty after rendering", () => {
      expect(() => buildMessage(args({ template: { subject: "S", body: "{pay_link}" } }))).toThrow(MessageError);
    });

    it("returns plain text with no HTML added", () => {
      const built = buildMessage(args({ template: { subject: "S", body: "<b>bold</b> & more" } }));
      expect(built.text.startsWith("<b>bold</b> & more")).toBe(true);
    });
  });
});
