// User actions on single messages, the Needs you queue and the next-7-days view.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import { ProviderAmbiguousError, ProviderRefusedError, type EmailProvider, type OutgoingEmail, type SendResult } from "@/lib/providers/types";
import {
  approveMessage,
  cancelMessage,
  editMessage,
  holdMessage,
  listNeedsYou,
  listNextSevenDays,
  resolveNeedsCheck,
  resumeMessage,
  retryFailed,
  runSender,
  setInvoiceStatus,
  InvalidStateError,
  ValidationError,
} from "@/lib/engine";
import {
  NOW,
  addClient,
  addInvoice,
  clockAt,
  depsFor,
  logsOf,
  planAt,
  rowsOf,
  rowStatus,
  setupUser,
  statusesOf,
  type Owner,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function invoiceWithPlan(owner: Owner, opts: { autoSend?: boolean; due?: string } = {}) {
  const client = await addClient(owner.userId, { autoSend: opts.autoSend ?? true, timezone: "UTC" });
  const invoiceId = await addInvoice(owner.userId, client.clientId, { due: opts.due ?? "2026-11-10" });
  await planAt(owner.userId, invoiceId);
  return { invoiceId, clientId: client.clientId };
}

async function stepIdAt(offset: number): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "select st.id from sequence_steps st join sequences s on s.id = st.sequence_id where s.is_default and s.kind = 'standard' and st.offset_days = $1 limit 1",
    [offset],
  );
  return rows[0].id;
}

describe("approve", () => {
  it("approves a pending message: it becomes scheduled and goes out at the next window", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: false });
    const pending = (await rowsOf(inv.invoiceId)).find((r) => r.status === "pending_approval")!;
    await approveMessage(owner.userId, pending.id, clockAt(NOW));
    expect(await rowStatus(pending.id)).toBe("scheduled");
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
  });

  it("refuses to approve a message that is not awaiting approval", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const scheduled = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await expect(approveMessage(owner.userId, scheduled.id, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("another user cannot approve this user's message", async () => {
    const owner = await setupUser();
    const other = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: false });
    const pending = (await rowsOf(inv.invoiceId)).find((r) => r.status === "pending_approval")!;
    await expect(approveMessage(other.userId, pending.id, clockAt(NOW))).rejects.toThrow();
    expect(await rowStatus(pending.id)).toBe("pending_approval");
  });
});

describe("edit", () => {
  it("changes the subject of that one message only", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const [a, b] = (await rowsOf(inv.invoiceId)).filter((r) => r.status === "scheduled");
    await editMessage(owner.userId, a.id, { subject: "A custom subject for {invoice_number}" }, clockAt(NOW));
    const rows = await rowsOf(inv.invoiceId);
    expect(rows.find((r) => r.id === a.id)!.subject_override).toBe("A custom subject for {invoice_number}");
    expect(rows.find((r) => r.id === b.id)!.subject_override).toBeNull();
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls[0].subject).toBe("A custom subject for " + (await adminQuery<{ invoice_number: string }>("select invoice_number from invoices where id = $1", [inv.invoiceId])).rows[0].invoice_number);
  });

  it("rejects an unknown merge field", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await expect(editMessage(owner.userId, row.id, { body: "Pay {amount_due} now" }, clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns a scheduled message to pending approval when its step requires approval", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && r.step_id !== null)!;
    await adminQuery("update sequence_steps set requires_approval = true where id = $1", [row.step_id]);
    await editMessage(owner.userId, row.id, { body: "Hello {client_name}, a short note about {invoice_number}." }, clockAt(NOW));
    expect(await rowStatus(row.id)).toBe("pending_approval");
  });

  it("a sent message cannot be edited", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set status = 'sent' where id = $1", [row.id]);
    await expect(editMessage(owner.userId, row.id, { body: "Changed {client_name}" }, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("hold, resume and cancel", () => {
  it("a held message is not sent, and resuming it sends it at its time", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    // The +7 step (2026-11-17 09:00) is still ahead at NOW.
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) > new Date(NOW))!;
    await holdMessage(owner.userId, row.id, clockAt(NOW));
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-17T12:00:00Z"), email));
    // The step due on 2026-11-10 is sent on this run. The held row is not.
    expect(email.calls.map((c) => c.idempotencyKey)).not.toContain(row.id);
    expect(await rowStatus(row.id)).toBe("held");
    await resumeMessage(owner.userId, row.id, clockAt(NOW));
    expect(await rowStatus(row.id)).toBe("scheduled");
    await runSender(depsFor(clockAt("2026-11-17T12:00:00Z"), email));
    expect(email.calls.map((c) => c.idempotencyKey)).toContain(row.id);
  });

  it("resuming a message whose planned time has passed skips it", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) <= new Date(NOW))!;
    await holdMessage(owner.userId, row.id, clockAt("2026-11-09T12:00:00Z"));
    await resumeMessage(owner.userId, row.id, clockAt("2026-11-11T12:00:00Z"));
    expect(await rowStatus(row.id)).toBe("skipped");
  });

  it("cancelling a message skips it, and resuming the invoice never revives it", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await cancelMessage(owner.userId, row.id, clockAt(NOW));
    expect(await rowStatus(row.id)).toBe("skipped");
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt(NOW));
    await setInvoiceStatus(owner.userId, inv.invoiceId, "open", clockAt(NOW));
    expect(await rowStatus(row.id)).toBe("skipped");
  });

  it("a sent message cannot be cancelled", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set status = 'sent' where id = $1", [row.id]);
    await expect(cancelMessage(owner.userId, row.id, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("failed sends and checks", () => {
  it("a failed send is retried only on the user's request", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const email = new FakeEmailProvider();
    email.nextFailure = "refused";
    await runSender(depsFor(clockAt(NOW), email));
    const failed = (await rowsOf(inv.invoiceId)).find((r) => r.status === "failed")!;
    await retryFailed(owner.userId, failed.id, clockAt(NOW));
    expect(await rowStatus(failed.id)).toBe("scheduled");
    const again = await runSender(depsFor(clockAt(NOW), email));
    expect(again.sent).toBe(1);
  });

  it("a retry is refused for a row that is not failed", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await expect(retryFailed(owner.userId, row.id, clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("marking an unknown send as sent logs it with manual = true and the recorded body", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const email = new FakeEmailProvider();
    email.nextFailure = "ambiguous";
    await runSender(depsFor(clockAt(NOW), email));
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "needs_check")!;
    await resolveNeedsCheck(owner.userId, row.id, "sent", clockAt("2026-11-10T12:30:00Z"));
    expect(await rowStatus(row.id)).toBe("sent");
    const logs = await logsOf(inv.invoiceId);
    expect(logs).toHaveLength(1);
    expect(logs[0].manual).toBe(true);
    expect(logs[0].provider_message_id).toBeNull();
    expect(logs[0].body_snapshot).toContain("Ada Studio");
    expect(email.calls).toHaveLength(1);
  });

  it("dismissing a needs_check message skips it and never sends it", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const email = new FakeEmailProvider();
    email.nextFailure = "ambiguous";
    await runSender(depsFor(clockAt(NOW), email));
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "needs_check")!;
    await resolveNeedsCheck(owner.userId, row.id, "skipped", clockAt("2026-11-10T12:30:00Z"));
    expect(await rowStatus(row.id)).toBe("skipped");
    expect(await logsOf(inv.invoiceId)).toHaveLength(0);
    await runSender(depsFor(clockAt("2026-11-10T12:35:00Z"), email));
    expect(email.calls).toHaveLength(1);
  });

  it("only a needs_check message can be resolved", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await expect(resolveNeedsCheck(owner.userId, row.id, "sent", clockAt(NOW))).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("Needs you and the next seven days", () => {
  it("lists pending approvals, and drops them once approved", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: false });
    const items = await listNeedsYou(owner.userId);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(3);
    const pending = (await rowsOf(inv.invoiceId)).find((r) => r.status === "pending_approval")!;
    await approveMessage(owner.userId, pending.id, clockAt(NOW));
    expect((await listNeedsYou(owner.userId)).filter((i) => i.kind === "approval")).toHaveLength(2);
  });

  it("each approval card for one invoice names its step, in the schedule's wording", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: false, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { number: "HC-3001", due: "2026-11-20" });
    await planAt(owner.userId, invoiceId);
    const titles = (await listNeedsYou(owner.userId))
      .filter((i) => i.kind === "approval" && i.invoiceId === invoiceId)
      .map((i) => i.title);
    expect(titles.sort()).toEqual([
      "Reminder HC-3001: 14 days after the due date",
      "Reminder HC-3001: 3 days before the due date",
      "Reminder HC-3001: 7 days after the due date",
      "Reminder HC-3001: on the due date",
    ].sort());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("lists failed sends, needs_check messages and disputed invoices", async () => {
    const owner = await setupUser();
    const first = await invoiceWithPlan(owner, { autoSend: true });
    const second = await invoiceWithPlan(owner, { autoSend: true });
    const disputed = await invoiceWithPlan(owner, { autoSend: true });
    await setInvoiceStatus(owner.userId, disputed.invoiceId, "disputed", clockAt(NOW));
    // First send is refused, second is ambiguous, the rest succeed.
    const outcomes: ("refused" | "ambiguous" | "ok")[] = ["refused", "ambiguous", "ok"];
    const provider: EmailProvider = {
      name: "fake",
      async send(email: OutgoingEmail): Promise<SendResult> {
        const next = outcomes.shift() ?? "ok";
        if (next === "refused") throw new ProviderRefusedError("refused");
        if (next === "ambiguous") throw new ProviderAmbiguousError("timeout");
        return { providerMessageId: `ok_${email.idempotencyKey}` };
      },
    };
    await runSender({ ...depsFor(clockAt(NOW)), emailFor: async () => provider });
    const items = await listNeedsYou(owner.userId);
    expect(items.filter((i) => i.kind === "failed")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "needs_check")).toHaveLength(1);
    expect(items.some((i) => i.kind === "disputed" && i.invoiceId === disputed.invoiceId)).toBe(true);
    expect(items.filter((i) => i.invoiceId === first.invoiceId || i.invoiceId === second.invoiceId).length).toBe(2);
  });

  it("lists the next seven days of planned messages and leaves out later ones", async () => {
    const owner = await setupUser();
    const near = await invoiceWithPlan(owner, { autoSend: true, due: "2026-11-12" });
    const later = await invoiceWithPlan(owner, { autoSend: true, due: "2026-12-20" });
    const upcoming = await listNextSevenDays(owner.userId, clockAt(NOW));
    expect(upcoming.some((u) => u.invoiceId === near.invoiceId)).toBe(true);
    expect(upcoming.some((u) => u.invoiceId === later.invoiceId)).toBe(false);
    const sample = upcoming.find((u) => u.invoiceId === near.invoiceId)!;
    expect(sample.contactEmail).toMatch(/@example\.test$/);
    expect(sample.amountMinor).toBe(10000);
  });

  it("the next-7-days list shows a held message and the message subject", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true, due: "2026-11-12" });
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) > new Date(NOW))!;
    await holdMessage(owner.userId, row.id, clockAt(NOW));
    const upcoming = await listNextSevenDays(owner.userId, clockAt(NOW));
    const held = upcoming.find((u) => u.messageId === row.id);
    expect(held?.status).toBe("held");
    expect(held?.subject).toBeTruthy();
  });

  it("reads do not change any row", async () => {
    const owner = await setupUser();
    const inv = await invoiceWithPlan(owner, { autoSend: true });
    const before = await statusesOf(inv.invoiceId);
    await listNeedsYou(owner.userId);
    await listNextSevenDays(owner.userId, clockAt(NOW));
    expect(await statusesOf(inv.invoiceId)).toEqual(before);
  });
});
