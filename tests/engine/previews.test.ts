// Unsent messages shown on the invoice timeline and in Next 7 days are rendered by the
// sender's render path. No merge token survives, the screens agree with what is sent,
// and a read never creates a payment link.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  approveMessage,
  getInvoiceDetail,
  holdMessage,
  listNextSevenDays,
  runSender,
  type MessageView,
} from "@/lib/engine";
import { NOW, PLAN_AT, addClient, addInvoice, clockAt, depsFor, planAt, rowsOf, setupUser, type Owner } from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

// Every unsent subject and body a screen returns must be free of merge tokens.
function unsentTexts(messages: MessageView[]): string[] {
  return messages
    .filter((m) => ["scheduled", "pending_approval", "held"].includes(m.status))
    .flatMap((m) => [m.subject, m.body])
    .filter((t): t is string => t !== null);
}

async function paymentLinkEvents(userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>(
    "select count(*)::text as n from events where user_id = $1 and type = 'payment_link_created'", [userId],
  );
  return Number(rows[0].n);
}

async function connectStripe(userId: string): Promise<void> {
  await adminQuery(
    "insert into connected_accounts (user_id, provider, secret_ciphertext) values ($1, 'stripe', 'not-a-real-ciphertext')",
    [userId],
  );
}

async function scenario(owner: Owner) {
  // Pending (client not auto-send), one held, and scheduled rows on different invoices.
  const manual = await addClient(owner.userId, { name: "Manual Co", autoSend: false, timezone: "America/New_York" });
  const pendingInvoice = await addInvoice(owner.userId, manual.clientId, { number: "INV-MANUAL", amountMinor: 10000, currency: "USD", due: "2026-11-10" });
  await planAt(owner.userId, pendingInvoice, PLAN_AT);
  const auto = await addClient(owner.userId, { name: "Auto Ltd", autoSend: true, timezone: "UTC" });
  const autoInvoice = await addInvoice(owner.userId, auto.clientId, { number: "INV-AUTO", amountMinor: 25050, currency: "EUR", due: "2026-11-10" });
  await planAt(owner.userId, autoInvoice, PLAN_AT);
  const held = (await rowsOf(pendingInvoice)).find((r) => r.status === "pending_approval")!;
  await holdMessage(owner.userId, held.id, clockAt(NOW));
  return { pendingInvoice, autoInvoice };
}

describe("unsent messages are rendered, never shown as raw templates", () => {
  it("the invoice timeline returns no merge token in any unsent subject or body", async () => {
    const owner = await setupUser();
    const s = await scenario(owner);
    const detail = await getInvoiceDetail(owner.userId, s.pendingInvoice);
    const unsent = detail.messages.filter((m) => ["scheduled", "pending_approval", "held"].includes(m.status));
    expect(unsent.length).toBeGreaterThan(0);
    for (const text of unsentTexts(detail.messages)) expect(text).not.toMatch(/[{}]/);
    expect(unsent.every((m) => m.textSource === "rendered" && m.render !== null)).toBe(true);
    expect(unsent.some((m) => m.status === "held")).toBe(true);
  });

  it("Next 7 days returns no merge token in any subject or body", async () => {
    const owner = await setupUser();
    await scenario(owner);
    const upcoming = await listNextSevenDays(owner.userId, clockAt(NOW));
    expect(upcoming.length).toBeGreaterThan(0);
    for (const m of upcoming) {
      expect(m.subject).not.toMatch(/[{}]/);
      expect(m.body).not.toMatch(/[{}]/);
    }
  });

  it("rendered text carries the real invoice number, amount, currency and client-timezone due date", async () => {
    const owner = await setupUser();
    const s = await scenario(owner);
    const detail = await getInvoiceDetail(owner.userId, s.pendingInvoice);
    const row = detail.messages.find((m) => m.status === "pending_approval")!;
    expect(row.subject).toContain("INV-MANUAL");
    expect(row.body).toContain("INV-MANUAL");
    expect(row.body).toContain("$100.00");
    // 2026-11-10 is the due date. It reads as a calendar date in the client's New York timezone.
    expect(row.body).toContain("10 Nov 2026");
    const euro = (await getInvoiceDetail(owner.userId, s.autoInvoice)).messages.find((m) => m.status === "scheduled")!;
    expect(euro.body).toContain("€250.50");
  });

  it("days overdue comes from the step: 0 before the due date, the offset after it", async () => {
    const owner = await setupUser();
    await adminQuery("update sequence_steps set body = 'Overdue by {days_overdue} days on {invoice_number}.' where offset_days in (0, 7) and user_id = $1", [owner.userId]);
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-DAYS", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const detail = await getInvoiceDetail(owner.userId, invoiceId);
    const dueStep = detail.messages.find((m) => m.stepOffsetDays === 0)!;
    const plusSeven = detail.messages.find((m) => m.stepOffsetDays === 7)!;
    expect(dueStep.body).toContain("Overdue by 0 days on INV-DAYS.");
    expect(plusSeven.body).toContain("Overdue by 7 days on INV-DAYS.");
  });

  it("a sent message keeps the text it was sent with, and the rendered text before the send matches it", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-SAME", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const before = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(1);
    const after = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(after.textSource).toBe("sent");
    expect(after.body).toBe(email.calls[0].text);
    expect(after.subject).toBe(email.calls[0].subject);
    // The screen and the sender agree before the send, as well as after it.
    expect(before.subject).toBe(email.calls[0].subject);
    expect(before.body).toBe(email.calls[0].text);
  });

  it("Next 7 days and the invoice timeline show the same subject and body for the same row", async () => {
    const owner = await setupUser();
    const s = await scenario(owner);
    const timeline = (await getInvoiceDetail(owner.userId, s.autoInvoice)).messages.filter((m) => m.status === "scheduled");
    const upcoming = (await listNextSevenDays(owner.userId, clockAt(NOW))).filter((u) => u.invoiceId === s.autoInvoice);
    expect(upcoming.length).toBeGreaterThan(0);
    for (const u of upcoming) {
      const match = timeline.find((t) => t.id === u.messageId)!;
      expect(match.subject).toBe(u.subject);
      expect(match.body).toBe(u.body);
    }
  });
});

describe("the payment-link line", () => {
  it("without Stripe, the pay line is dropped and no placeholder appears", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-NOPAY", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.paymentLink).toBe("omitted");
    expect(row.body).not.toContain("[payment link]");
    expect(row.body).not.toMatch(/pay online/i);
  });

  it("with Stripe and no link yet, the placeholder shows and no link is created", async () => {
    const owner = await setupUser();
    await connectStripe(owner.userId);
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-PLACE", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.paymentLink).toBe("placeholder");
    expect(row.body).toContain("[payment link]");
    await listNextSevenDays(owner.userId, clockAt(NOW));
    const { rows } = await adminQuery<{ stripe_payment_link_id: string | null }>("select stripe_payment_link_id from invoices where id = $1", [invoiceId]);
    expect(rows[0].stripe_payment_link_id).toBeNull();
    expect(await paymentLinkEvents(owner.userId)).toBe(0);
  });

  it("with Stripe and a reusable stored link, the stored URL shows", async () => {
    const owner = await setupUser();
    await connectStripe(owner.userId);
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-LINK", amountMinor: 10000, currency: "USD", due: "2026-11-10" });
    await adminQuery(
      `update invoices set stripe_payment_link_id = 'plink_stored_1', stripe_payment_link_url = 'https://pay.example.test/plink_stored_1',
         stripe_link_amount_minor = 10000, stripe_link_currency = 'USD' where id = $1`,
      [invoiceId],
    );
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.paymentLink).toBe("included");
    expect(row.body).toContain("https://pay.example.test/plink_stored_1");
  });

  it("a stored link for a different amount is not shown; the placeholder is", async () => {
    const owner = await setupUser();
    await connectStripe(owner.userId);
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-OLD", amountMinor: 12000, currency: "USD", due: "2026-11-10" });
    await adminQuery(
      `update invoices set stripe_payment_link_id = 'plink_old', stripe_payment_link_url = 'https://pay.example.test/plink_old',
         stripe_link_amount_minor = 10000, stripe_link_currency = 'USD' where id = $1`,
      [invoiceId],
    );
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.paymentLink).toBe("placeholder");
    expect(row.body).not.toContain("plink_old");
  });

  it("reads create no payment-link rows, even with Stripe connected", async () => {
    const owner = await setupUser();
    await connectStripe(owner.userId);
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-READ", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    for (let i = 0; i < 3; i++) {
      await getInvoiceDetail(owner.userId, invoiceId);
      await listNextSevenDays(owner.userId, clockAt(NOW));
    }
    expect(await paymentLinkEvents(owner.userId)).toBe(0);
    const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from invoices where user_id = $1 and stripe_payment_link_id is not null", [owner.userId]);
    expect(rows[0].n).toBe("0");
  });
});

describe("an incomplete sender profile and a broken client timezone", () => {
  it("fills the merge fields with placeholders where the profile is blank and leaves the footer out", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-PROFILE", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    await adminQuery("update settings set sender_name = '', business_name = '', postal_address = '' where user_id = $1", [owner.userId]);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.profileComplete).toBe(false);
    expect(row.render?.footerIncluded).toBe(false);
    expect(row.body).not.toContain("---");
    expect(row.body).toContain("[sender name]");
    expect(row.body).toContain("INV-PROFILE");
    expect(row.body).not.toMatch(/[{}]/);
    const upcoming = (await listNextSevenDays(owner.userId, clockAt(NOW))).find((u) => u.invoiceId === invoiceId)!;
    expect(upcoming.render.footerIncluded).toBe(false);
    expect(upcoming.body).not.toContain("---");
  });

  it("keeps the footer when the profile is complete", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-FOOT", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.render?.footerIncluded).toBe(true);
    expect(row.body).toContain("Ada Studio");
    expect(row.body).toContain("1 Main St, Springfield");
  });

  it("a client timezone that is no longer valid reports a render error instead of a raw template", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "INV-TZ", due: "2026-11-10" });
    await planAt(owner.userId, invoiceId, PLAN_AT);
    await adminQuery("update clients set timezone = 'Mars/Olympus' where id = $1", [client.clientId]);
    const row = (await getInvoiceDetail(owner.userId, invoiceId)).messages.find((m) => m.stepOffsetDays === 0)!;
    expect(row.subject).toBeNull();
    expect(row.body).toBeNull();
    expect(row.render?.renderError).toBeTruthy();
  });
});


