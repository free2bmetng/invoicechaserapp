// Server actions for Needs you and Next 7 days, through their exported functions.
// The session and cache layer are mocked; the engine and database are real. Covers:
// the session requirement, input validation, ownership (another account's items are
// refused and left untouched), and the state changes of the happy paths.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import * as actions from "@/app/actions/ops";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { recordPayment, recordReply, setInvoiceStatus } from "@/lib/engine";
import { loadNeedsYou } from "@/lib/queries/ops";
import { requireUserId } from "@/lib/session";
import { adminQuery } from "../helpers/db";
import {
  messageFor,
  newClient,
  PLAN_ISO,
  newInvoice,
  newUser,
  resetDb,
  runSendWindow,
  ScriptedEmail,
  setRowStatus,
  statusOf,
} from "./fixtures";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/session", () => ({
  requireUserId: vi.fn(async () => {
    if (!session.userId) throw new Error("NEXT_REDIRECT:/login");
    return session.userId;
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const BAD_ITEM = "That item could not be found. Refresh the page and try again.";

function fields(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

beforeEach(async () => {
  await resetDb();
  session.userId = null;
  vi.mocked(requireUserId).mockClear();
  vi.mocked(revalidatePath).mockClear();
});

afterAll(async () => {
  await closeDb();
});

// A manual-approval invoice: its reminders wait in Needs you as pending_approval.
async function awaitingApproval(userId: string) {
  const client = await newClient(userId, { name: "Harbour & Co", autoSend: false });
  const invoiceId = await newInvoice(userId, client.clientId, { number: uniqueNumber(), due: "2030-01-12" });
  return { client, messageId: await messageFor(invoiceId, 0, "pending_approval"), invoiceId };
}

// An auto-send invoice: its first reminder is scheduled, due on 10 January.
async function scheduled(userId: string) {
  const client = await newClient(userId, { autoSend: true });
  const invoiceId = await newInvoice(userId, client.clientId, { number: uniqueNumber(), due: "2030-01-10" });
  return { client, messageId: await messageFor(invoiceId, 0, "scheduled"), invoiceId };
}

let numbers = 0;
function uniqueNumber(): string {
  numbers += 1;
  return `ACT-${numbers}`;
}

const OK = { ok: true, message: expect.any(String) };
function failed(message?: string) {
  return message === undefined ? { ok: false, message: expect.any(String) } : { ok: false, message };
}

describe("every action requires a signed-in user", () => {
  it("rejects before touching anything when there is no session", async () => {
    const owner = await newUser();
    const { messageId, client } = await awaitingApproval(owner);
    session.userId = null;

    await expect(actions.approveReminder(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.approveWithEdit(fields({ messageId, subject: "x", body: "y" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.saveReminderEdit(fields({ messageId, subject: "x", body: "y" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.holdReminder(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.resumeReminder(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.cancelReminder(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.retryReminder(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.markReminderSent(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.dismissReminderCheck(fields({ messageId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.resumeClientReminders(fields({ clientId: client.clientId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.cancelHeldReminders(fields({ clientId: client.clientId }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(actions.resumeAddress(fields({ contactId: client.contactId }))).rejects.toThrow("NEXT_REDIRECT");

    expect(await statusOf(messageId)).toBe("pending_approval");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("input validation", () => {
  beforeEach(async () => {
    session.userId = await newUser();
  });

  it("refuses a missing or malformed item id, without calling the engine", async () => {
    await expect(actions.approveReminder(fields({}))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    await expect(actions.approveReminder(fields({ messageId: "nope" }))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    await expect(actions.holdReminder(fields({ messageId: "1; drop table users" }))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    await expect(actions.resumeAddress(fields({ contactId: "" }))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    await expect(actions.cancelHeldReminders(fields({ clientId: "x" }))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("checks the edited text before saving it", async () => {
    const { messageId } = await awaitingApproval(session.userId!);
    const cases: Array<[Record<string, string>, string]> = [
      [{ messageId, subject: "   ", body: "Hello" }, "Add a subject line."],
      [{ messageId, subject: "Hi", body: "  " }, "Add the message body."],
      [{ messageId, subject: "Two\nlines", body: "Hello" }, "The subject must fit on one line."],
      [{ messageId, subject: "x".repeat(301), body: "Hello" }, "The subject must be 300 characters or fewer."],
      [{ messageId, subject: "Hi", body: "x".repeat(10_001) }, "The message must be 10,000 characters or fewer."],
    ];
    for (const [values, message] of cases) {
      await expect(actions.approveWithEdit(fields(values))).resolves.toEqual({ ok: false, message });
      await expect(actions.saveReminderEdit(fields(values))).resolves.toEqual({ ok: false, message });
    }
    expect(await statusOf(messageId)).toBe("pending_approval");
  });

  it("rejects an unknown merge field, and leaves the reminder as it was", async () => {
    const { messageId } = await awaitingApproval(session.userId!);
    const result = await actions.approveWithEdit(fields({ messageId, subject: "Hi {client_nme}", body: "Thanks" }));
    expect(result).toEqual(failed());
    expect(result.ok).toBe(false);
    expect(await statusOf(messageId)).toBe("pending_approval");
    const { rows } = await adminQuery<{ subject_override: string | null }>(
      "select subject_override from scheduled_messages where id = $1",
      [messageId],
    );
    expect(rows[0].subject_override).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("ownership: another account's items are refused and left alone", () => {
  it("refuses every single-item action on another user's reminder", async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const { messageId, client } = await awaitingApproval(owner);
    session.userId = attacker;

    const calls = [
      actions.approveReminder(fields({ messageId })),
      actions.approveWithEdit(fields({ messageId, subject: "Hi", body: "Hello" })),
      actions.saveReminderEdit(fields({ messageId, subject: "Hi", body: "Hello" })),
      actions.holdReminder(fields({ messageId })),
      actions.resumeReminder(fields({ messageId })),
      actions.cancelReminder(fields({ messageId })),
      actions.retryReminder(fields({ messageId })),
      actions.markReminderSent(fields({ messageId })),
      actions.dismissReminderCheck(fields({ messageId })),
      actions.resumeAddress(fields({ contactId: client.contactId })),
      actions.resumeClientReminders(fields({ clientId: client.clientId })),
      actions.cancelHeldReminders(fields({ clientId: client.clientId })),
    ];
    for (const call of calls) {
      expect(await call).toEqual(failed());
    }

    expect(await statusOf(messageId)).toBe("pending_approval");
    const { rows } = await adminQuery<{ subject_override: string | null }>(
      "select subject_override from scheduled_messages where id = $1",
      [messageId],
    );
    expect(rows[0].subject_override).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("happy paths", () => {
  beforeEach(async () => {
    session.userId = await newUser();
  });

  it("approves a reminder, moves it to scheduled, and refreshes the app", async () => {
    const { messageId } = await awaitingApproval(session.userId!);
    await expect(actions.approveReminder(fields({ messageId }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("scheduled");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("edits then approves in one action, saving the text on this reminder only", async () => {
    const { messageId } = await awaitingApproval(session.userId!);
    const result = await actions.approveWithEdit(
      fields({ messageId, subject: "Quick check on {invoice_number}", body: "Hello {client_name}, {amount} is due. Thanks." }),
    );
    expect(result).toEqual(OK);
    expect(await statusOf(messageId)).toBe("scheduled");
    const { rows } = await adminQuery<{ subject_override: string; body_override: string }>(
      "select subject_override, body_override from scheduled_messages where id = $1",
      [messageId],
    );
    expect(rows[0].subject_override).toBe("Quick check on {invoice_number}");
    expect(rows[0].body_override).toContain("{amount} is due");
  });

  it("holds and then resumes a reminder", async () => {
    const { messageId } = await scheduled(session.userId!);
    await expect(actions.holdReminder(fields({ messageId }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("held");
    await expect(actions.resumeReminder(fields({ messageId }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("scheduled");
  });

  it("cancels a reminder, and cancelled reminders stay cancelled", async () => {
    const { messageId } = await scheduled(session.userId!);
    await expect(actions.cancelReminder(fields({ messageId }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("skipped");
  });

  it("saves an edit to a scheduled reminder without changing its status", async () => {
    const { messageId } = await scheduled(session.userId!);
    await expect(actions.saveReminderEdit(fields({ messageId, subject: "Hi", body: "Hello {client_name}" }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("scheduled");
  });

  it("sends an edited reminder back for approval when its step needs approval", async () => {
    const { messageId } = await scheduled(session.userId!);
    await adminQuery(
      `update sequence_steps set requires_approval = true
        where user_id = $1 and offset_days = 0 and sequence_id in (select id from sequences where user_id = $1 and kind = 'standard')`,
      [session.userId],
    );
    await expect(actions.saveReminderEdit(fields({ messageId, subject: "Hi", body: "Hello" }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("pending_approval");
  });

  it("retries a failed send, and marks a delivery check as sent (logged as manual)", async () => {
    const owner = session.userId!;
    const refused = await newClient(owner, { autoSend: true });
    const refusedInvoice = await newInvoice(owner, refused.clientId, { number: uniqueNumber(), due: "2030-01-10" });
    const timedOut = await newClient(owner, { autoSend: true });
    await newInvoice(owner, timedOut.clientId, { number: uniqueNumber(), due: "2030-01-10" });
    await runSendWindow(new ScriptedEmail(new Set([refused.email]), new Set([timedOut.email])));

    const failedRow = await messageFor(refusedInvoice, 0, "failed");
    await expect(actions.retryReminder(fields({ messageId: failedRow }))).resolves.toEqual(OK);
    expect(await statusOf(failedRow)).toBe("scheduled");

    const check = (await adminQuery<{ id: string }>(
      "select id from scheduled_messages where user_id = $1 and status = 'needs_check'",
      [owner],
    )).rows[0].id;
    await expect(actions.markReminderSent(fields({ messageId: check }))).resolves.toEqual(OK);
    expect(await statusOf(check)).toBe("sent");
    const { rows } = await adminQuery<{ manual: boolean }>("select manual from message_log where scheduled_message_id = $1", [check]);
    expect(rows[0].manual).toBe(true);
  });

  it("dismisses a delivery check without sending it", async () => {
    const owner = session.userId!;
    const { messageId } = await scheduled(owner);
    await setRowStatus(messageId, "needs_check");
    await expect(actions.dismissReminderCheck(fields({ messageId }))).resolves.toEqual(OK);
    expect(await statusOf(messageId)).toBe("skipped");
  });

  it("resumes a bounced address, and clears its hold", async () => {
    const owner = session.userId!;
    const client = await newClient(owner, { autoSend: true });
    await adminQuery("update contacts set hold = 'bounced' where id = $1", [client.contactId]);
    await expect(actions.resumeAddress(fields({ contactId: client.contactId }))).resolves.toEqual(OK);
    const { rows } = await adminQuery<{ hold: string | null }>("select hold from contacts where id = $1", [client.contactId]);
    expect(rows[0].hold).toBeNull();
  });

  it("resumes a client who replied, and cancels the client's held reminders", async () => {
    const owner = session.userId!;
    const client = await newClient(owner, { autoSend: true });
    await newInvoice(owner, client.clientId, { number: uniqueNumber(), due: "2030-01-12" });
    const other = await newClient(owner, { autoSend: true });
    await newInvoice(owner, other.clientId, { number: uniqueNumber(), due: "2030-01-12" });
    await recordReply({ userId: owner, clientId: client.clientId, clock: fixedClock("2030-01-09T09:00:00.000Z") });

    const cancelled = await actions.cancelHeldReminders(fields({ clientId: client.clientId }));
    expect(cancelled).toEqual({ ok: true, message: expect.stringMatching(/^Cancelled \d+ held reminders?\.$/) });
    const { rows } = await adminQuery<{ n: string }>(
      "select count(*)::text as n from scheduled_messages where user_id = $1 and status = 'held'",
      [owner],
    );
    expect(rows[0].n).toBe("0");
    // The other client's reminders are not touched.
    expect((await adminQuery<{ n: string }>(
      "select count(*)::text as n from scheduled_messages m join invoices i on i.id = m.invoice_id where m.user_id = $1 and i.client_id = $2 and m.status = 'scheduled'",
      [owner, other.clientId],
    )).rows[0].n).not.toBe("0");

    await expect(actions.resumeClientReminders(fields({ clientId: client.clientId }))).resolves.toEqual(OK);
    const reply = await adminQuery<{ reply_held_at: Date | null }>("select reply_held_at from clients where id = $1", [client.clientId]);
    expect(reply.rows[0].reply_held_at).toBeNull();
  });
});

describe("marking a payment that arrived while disputed as reviewed", () => {
  // A disputed invoice that is then paid. The engine flags the payment for review.
  async function paidWhileDisputed(owner: string): Promise<string> {
    const client = await newClient(owner, { autoSend: false });
    const invoiceId = await newInvoice(owner, client.clientId, { number: uniqueNumber(), due: "2030-01-12" });
    await setInvoiceStatus(owner, invoiceId, "disputed", fixedClock(PLAN_ISO));
    await recordPayment({
      userId: owner,
      invoiceId,
      installmentId: null,
      paidAt: new Date("2030-01-05T12:00:00Z"),
      source: "manual",
      clock: fixedClock(PLAN_ISO),
    });
    return invoiceId;
  }

  async function openReviewInvoiceIds(owner: string): Promise<string[]> {
    const view = await loadNeedsYou(owner);
    return (view.sections.find((section) => section.kind === "paid_while_disputed")?.rows ?? []).map((row) => row.invoiceId ?? "");
  }

  it("requires a signed-in user", async () => {
    const owner = await newUser();
    const invoiceId = await paidWhileDisputed(owner);
    session.userId = null;
    await expect(actions.acknowledgePaidWhileDisputedAction(fields({ invoiceId }))).rejects.toThrow("NEXT_REDIRECT");
    expect(await openReviewInvoiceIds(owner)).toContain(invoiceId);
  });

  it("refuses a missing or malformed invoice id", async () => {
    session.userId = await newUser();
    await expect(actions.acknowledgePaidWhileDisputedAction(fields({}))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    await expect(actions.acknowledgePaidWhileDisputedAction(fields({ invoiceId: "nope" }))).resolves.toEqual({ ok: false, message: BAD_ITEM });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses another account's invoice, and leaves the owner's item open", async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const invoiceId = await paidWhileDisputed(owner);
    session.userId = attacker;
    await expect(actions.acknowledgePaidWhileDisputedAction(fields({ invoiceId }))).resolves.toEqual(failed());
    expect(await openReviewInvoiceIds(owner)).toContain(invoiceId);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("clears the item with a calm status, and a second press says it was already reviewed", async () => {
    const owner = await newUser();
    const invoiceId = await paidWhileDisputed(owner);
    session.userId = owner;
    expect(await openReviewInvoiceIds(owner)).toContain(invoiceId);

    await expect(actions.acknowledgePaidWhileDisputedAction(fields({ invoiceId }))).resolves.toEqual({
      ok: true,
      message: "Marked as reviewed. It will not show here again.",
    });
    expect(await openReviewInvoiceIds(owner)).not.toContain(invoiceId);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");

    await expect(actions.acknowledgePaidWhileDisputedAction(fields({ invoiceId }))).resolves.toEqual({
      ok: true,
      message: "This item was already reviewed.",
    });
  });
});
