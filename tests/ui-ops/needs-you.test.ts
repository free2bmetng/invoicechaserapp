// Needs you: the queue sections, the reminder detail and preview, and tenant isolation.
// Failed and delivery-check rows come from the real sender, using scripted provider outcomes.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { recordBounce, recordReply, setInvoiceStatus } from "@/lib/engine";
import { loadNeedsYou, loadReminderDetails } from "@/lib/queries/ops";
import { adminQuery } from "../helpers/db";
import {
  messageFor,
  newClient,
  newInvoice,
  newUser,
  PLAN_ISO,
  resetDb,
  runSendWindow,
  ScriptedEmail,
  statusOf,
} from "./fixtures";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

async function providerIdFor(messageId: string): Promise<string> {
  const { rows } = await adminQuery<{ provider_message_id: string }>(
    "select provider_message_id from message_log where scheduled_message_id = $1",
    [messageId],
  );
  if (!rows[0]?.provider_message_id) throw new Error("no provider message id");
  return rows[0].provider_message_id;
}

describe("loadNeedsYou", () => {
  it("lists every kind of item in the spec's order, each with its reminder detail", async () => {
    const userId = await newUser();

    // Manual approval: a client with no history gets every reminder held for approval.
    const manual = await newClient(userId, { name: "Harbour & Co", autoSend: false });
    const awaiting = await newInvoice(userId, manual.clientId, { number: "HC-1", amountMinor: 185000, currency: "GBP", due: "2030-01-12" });

    // Sends: one refused, one timed out, one that goes out and then bounces.
    const refused = await newClient(userId, { name: "Orion Logistics", autoSend: true });
    await newInvoice(userId, refused.clientId, { number: "OR-1", due: "2030-01-10" });
    const timedOut = await newClient(userId, { name: "Lantern Books", autoSend: true });
    await newInvoice(userId, timedOut.clientId, { number: "LB-1", due: "2030-01-10" });
    const sends = await newClient(userId, { name: "Maple Print", autoSend: true });
    await newInvoice(userId, sends.clientId, { number: "MP-1", due: "2030-01-10" });

    // Replies: a client who replied has its reminders held.
    const replied = await newClient(userId, { name: "Quill Labs", autoSend: true });
    await newInvoice(userId, replied.clientId, { number: "QL-1", due: "2030-01-12" });
    await recordReply({ userId, clientId: replied.clientId, clock: fixedClock("2030-01-10T09:30:00.000Z") });

    // A disputed invoice.
    const disputed = await newClient(userId, { name: "Paper Crane", autoSend: true });
    const pc = await newInvoice(userId, disputed.clientId, { number: "PC-1", due: "2030-01-20" });
    await setInvoiceStatus(userId, pc, "disputed", fixedClock(PLAN_ISO));

    const email = new ScriptedEmail(new Set([refused.email]), new Set([timedOut.email]));
    await runSendWindow(email);

    const mapleMessage = await messageFor(await invoiceByNumber(userId, "MP-1"));
    expect(await statusOf(mapleMessage)).toBe("sent");
    await recordBounce({ provider: "fake", providerMessageId: await providerIdFor(mapleMessage), clock: fixedClock("2030-01-10T11:00:00.000Z") });

    const view = await loadNeedsYou(userId);
    // DESIGN_V2: most urgent first. Things that broke lead, then decisions, then information.
    expect(view.sections.map((s) => s.kind)).toEqual(["failed", "needs_check", "bounce", "approval", "reply", "disputed"]);
    expect(view.total).toBe(view.sections.reduce((n, s) => n + s.rows.length, 0));

    const approvals = view.sections.find((s) => s.kind === "approval")!;
    // Four steps for the manual client's invoice: 3 days before, due date, +7 and +14.
    expect(approvals.rows).toHaveLength(4);
    const approvalRow = approvals.rows.find((r) => r.reminder?.invoiceId === awaiting)!;
    expect(approvalRow.reminder?.invoiceNumber).toBe("HC-1");
    expect(approvalRow.reminder?.clientName).toBe("Harbour & Co");
    expect(approvalRow.reminder?.status).toBe("pending_approval");
    expect(approvalRow.reminder?.amountMinor).toBe(185000);
    expect(approvalRow.reminder?.currency).toBe("GBP");
    expect(approvalRow.reminder?.contactEmail).toBe(manual.email);
    expect(approvalRow.reminder?.preview?.text).toContain("Okafor Studio");
    expect(approvalRow.reminder?.preview?.text).toContain("14 Canal Street");

    expect(view.sections.find((s) => s.kind === "failed")!.rows[0].reminder?.clientName).toBe("Orion Logistics");
    expect(view.sections.find((s) => s.kind === "needs_check")!.rows[0].reminder?.clientName).toBe("Lantern Books");
    expect(view.sections.find((s) => s.kind === "reply")!.rows[0].clientId).toBe(replied.clientId);
    expect(view.sections.find((s) => s.kind === "bounce")!.rows[0].contactId).toBeTruthy();
    // The bounce keeps its hold until resumed. The address counts as fixed only once it changes.
    const bounceRow = view.sections.find((s) => s.kind === "bounce")!.rows[0];
    expect(bounceRow.bounce).toEqual({ currentEmail: sends.email, bouncedEmail: sends.email });
    expect(view.sections.find((s) => s.kind === "disputed")!.rows[0].invoiceId).toBe(pc);

    // Rows lead with the client and carry the money at stake.
    const failedRow = view.sections.find((s) => s.kind === "failed")!.rows[0];
    expect(failedRow.clientName).toBe("Orion Logistics");
    expect(failedRow.line.title).toBe("OR-1");
    expect(failedRow.atStake).toEqual([{ amountMinor: 10000, currency: "USD" }]);
    expect(approvalRow.clientName).toBe("Harbour & Co");
    expect(approvalRow.invoiceApprovals).toBe(approvals.rows.length);
    const replyRow = view.sections.find((s) => s.kind === "reply")!.rows[0];
    expect(replyRow.clientName).toBe("Quill Labs");
    expect(replyRow.heldCount).toBeGreaterThan(0);
    expect(replyRow.atStake).toEqual([{ amountMinor: 10000, currency: "USD" }]);
    const disputedRow = view.sections.find((s) => s.kind === "disputed")!.rows[0];
    expect(disputedRow.invoiceNumber).toBe("PC-1");
    expect(disputedRow.clientName).toBe("Paper Crane");
  });

  it("shows what was meant to go out for a delivery check, from the text recorded before the provider call", async () => {
    const userId = await newUser();
    const client = await newClient(userId, { name: "Lantern Books", autoSend: true });
    await newInvoice(userId, client.clientId, { number: "LB-2", due: "2030-01-10" });
    await runSendWindow(new ScriptedEmail(new Set(), new Set([client.email])));

    const view = await loadNeedsYou(userId);
    const check = view.sections.find((s) => s.kind === "needs_check")!.rows[0].reminder!;
    expect(check.attempt).not.toBeNull();
    expect(check.attempt?.text).toContain("Okafor Studio");
  });

  it("returns an empty view for a user with nothing waiting", async () => {
    const userId = await newUser();
    const view = await loadNeedsYou(userId);
    expect(view.total).toBe(0);
    expect(view.sections).toEqual([]);
  });

  it("never shows another user's items", async () => {
    const owner = await newUser();
    const other = await newUser();
    const client = await newClient(owner, { autoSend: false });
    await newInvoice(owner, client.clientId, { due: "2030-01-12" });

    expect((await loadNeedsYou(owner)).total).toBeGreaterThan(0);
    expect((await loadNeedsYou(other)).total).toBe(0);
  });
});

describe("loadReminderDetails", () => {
  it("explains why no preview is shown when the sender profile is incomplete", async () => {
    const userId = await newUser();
    const client = await newClient(userId, { autoSend: false });
    await newInvoice(userId, client.clientId, { number: "IN-1", due: "2030-01-12" });
    const messageId = await messageFor(await invoiceByNumber(userId, "IN-1"));

    // Planning needs a complete profile, so the profile is cleared after the reminder exists.
    await adminQuery("update settings set sender_name = '' where user_id = $1", [userId]);

    const details = await loadReminderDetails(userId, [messageId]);
    const detail = details.get(messageId)!;
    expect(detail.preview).toBeNull();
    expect(detail.previewNote).toContain("sender profile");
  });

  it("returns nothing for another user's reminder ids", async () => {
    const owner = await newUser();
    const other = await newUser();
    const client = await newClient(owner, { autoSend: false });
    await newInvoice(owner, client.clientId, { number: "AU-1", due: "2030-01-12" });
    const messageId = await messageFor(await invoiceByNumber(owner, "AU-1"));

    expect((await loadReminderDetails(other, [messageId])).size).toBe(0);
    expect((await loadReminderDetails(owner, ["not-a-uuid"])).size).toBe(0);
    expect((await loadReminderDetails(owner, [])).size).toBe(0);
  });

  it("gives the editor the template text, and the step it belongs to", async () => {
    const userId = await newUser();
    const client = await newClient(userId, { autoSend: false });
    await newInvoice(userId, client.clientId, { number: "ST-1", due: "2030-01-12" });
    const messageId = await messageFor(await invoiceByNumber(userId, "ST-1"), 0);

    const detail = (await loadReminderDetails(userId, [messageId])).get(messageId)!;
    expect(detail.subject.length).toBeGreaterThan(0);
    expect(detail.body).toContain("{invoice_number}");
    expect(detail.stepLabel).toBe("Friendly reminder, on the due date");
    expect(detail.hasStep).toBe(true);
  });
});

// Resolves an invoice id from its number, through the superuser, for test lookups.
async function invoiceByNumber(userId: string, number: string): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "select id from invoices where user_id = $1 and invoice_number = $2",
    [userId, number],
  );
  return rows[0].id;
}
