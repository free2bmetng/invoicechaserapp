// The sender: exactly one provider call per step, windows, the daily cap, failure
// mapping, payment links, footers and stops that race a send. Real Postgres, fake providers.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider, FakePaymentProvider } from "@/lib/providers/fake";
import type { EmailProvider, OutgoingEmail, SendResult } from "@/lib/providers/types";
import {
  approveMessage,
  retryFailed,
  runSender,
  setInvoiceStatus,
  resumeClient,
  recordReply,
} from "@/lib/engine";
import {
  NOW,
  PLAN_AT,
  addCc,
  addClient,
  addContact,
  addInstallments,
  addInvoice,
  clockAt,
  depsFor,
  eventTypes,
  invoiceRow,
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

// One client and one invoice due on 2026-11-10, planned before the due date.
// At NOW the step on the due date is due and everything else is in the future.
async function dueInvoice(owner: Owner, opts: { due?: string; timezone?: string | null; autoSend?: boolean; amountMinor?: number } = {}) {
  const client = await addClient(owner.userId, { autoSend: opts.autoSend ?? true, timezone: opts.timezone ?? null });
  const invoiceId = await addInvoice(owner.userId, client.clientId, { due: opts.due ?? "2026-11-10", amountMinor: opts.amountMinor });
  await planAt(owner.userId, invoiceId);
  return { invoiceId, clientId: client.clientId, contactId: client.contactId, email: client.email };
}

function gatedProvider() {
  let release!: () => void;
  let started!: () => void;
  const releaseP = new Promise<void>((resolve) => (release = resolve));
  const startedP = new Promise<void>((resolve) => (started = resolve));
  const calls: OutgoingEmail[] = [];
  const provider: EmailProvider = {
    name: "fake",
    async send(email: OutgoingEmail): Promise<SendResult> {
      calls.push(email);
      started();
      await releaseP;
      return { providerMessageId: `gate_${calls.length}` };
    },
  };
  return { provider, calls, startedP, release };
}

describe("one provider call per step", () => {
  it("sends the due step once, with the spec's From, Reply-To, To, CC, footer and idempotency key", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const cc = await addContact(owner.userId, (await adminQuery<{ client_id: string }>("select client_id from contacts where id = $1", [inv.contactId])).rows[0].client_id, "finance@acme.example.test");
    await addCc(owner.userId, inv.invoiceId, cc);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
    const sent = email.calls[0];
    expect(sent.from).toEqual({ name: "Ada Lovelace", address: "invoices@mail.example.test" });
    expect(sent.replyTo).toBe(owner.email);
    expect(sent.to).toBe(inv.email);
    expect(sent.cc).toEqual(["finance@acme.example.test"]);
    expect(sent.text).toContain("1 Main St, Springfield");
    expect(sent.text.trimEnd().endsWith("1 Main St, Springfield")).toBe(true);
    expect(sent.text).toContain("Ada Studio");
    const [row] = await rowsOf(inv.invoiceId).then((rs) => rs.filter((r) => r.status === "sent"));
    expect(sent.idempotencyKey).toBe(row.id);
  });

  it("every provider call has a message_log row carrying its provider message id", async () => {
    const owner = await setupUser();
    for (let i = 0; i < 3; i++) await dueInvoice(owner);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    const logs = await adminQuery<{ provider_message_id: string; manual: boolean }>(
      "select provider_message_id, manual from message_log where user_id = $1", [owner.userId],
    );
    expect(email.calls).toHaveLength(3);
    expect(logs.rows).toHaveLength(3);
    expect(logs.rows.every((r) => r.manual === false && r.provider_message_id?.startsWith("fake_"))).toBe(true);
    expect(new Set(logs.rows.map((r) => r.provider_message_id)).size).toBe(3);
  });

  it("back-to-back runs send nothing extra", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const email = new FakeEmailProvider();
    const first = await runSender(depsFor(clockAt(NOW), email));
    const second = await runSender(depsFor(clockAt(NOW), email));
    const third = await runSender(depsFor(clockAt("2026-11-10T12:05:00Z"), email));
    expect(first.sent).toBe(1);
    expect(second.claimed).toBe(0);
    expect(third.claimed).toBe(0);
    expect(email.calls).toHaveLength(1);
    expect((await statusesOf(inv.invoiceId)).filter((s) => s === "sent")).toHaveLength(1);
  });

  it("two overlapping runs produce exactly one provider call per step", async () => {
    const owner = await setupUser();
    for (let i = 0; i < 4; i++) await dueInvoice(owner);
    const email = new FakeEmailProvider();
    const [a, b] = await Promise.all([
      runSender(depsFor(clockAt(NOW), email), { batchSize: 2 }),
      runSender(depsFor(clockAt(NOW), email), { batchSize: 2 }),
    ]);
    expect(a.claimed + b.claimed).toBe(4);
    expect(email.calls).toHaveLength(4);
    expect(new Set(email.calls.map((c) => c.idempotencyKey)).size).toBe(4);
    expect(email.accepted.size).toBe(4);
  });

  it("overlapping runs with a single batch still send each step once", async () => {
    const owner = await setupUser();
    for (let i = 0; i < 3; i++) await dueInvoice(owner);
    const email = new FakeEmailProvider();
    await Promise.all([runSender(depsFor(clockAt(NOW), email)), runSender(depsFor(clockAt(NOW), email))]);
    expect(email.calls).toHaveLength(3);
    expect(new Set(email.calls.map((c) => c.idempotencyKey)).size).toBe(3);
  });
});

describe("windows and the daily cap", () => {
  it("sends at exactly 09:00 in the client's timezone", async () => {
    const owner = await setupUser();
    await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" });
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt("2026-11-10T09:00:00.000Z"), email));
    expect(result.sent).toBe(1);
  });

  it("defers a message whose time falls outside the window; it is not dropped", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" });
    const email = new FakeEmailProvider();
    const late = await runSender(depsFor(clockAt("2026-11-10T17:00:00.000Z"), email));
    expect(late.deferred).toBe(1);
    expect(email.calls).toHaveLength(0);
    const deferred = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) <= new Date("2026-11-10T17:00:00Z"));
    expect(deferred).toBeUndefined();
    const next = (await rowsOf(inv.invoiceId)).find((r) => new Date(r.planned_at).toISOString() === "2026-11-11T09:00:00.000Z");
    expect(next?.status).toBe("scheduled");
    const morning = await runSender(depsFor(clockAt("2026-11-11T09:30:00.000Z"), email));
    expect(morning.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
  });

  it("defers a message due before 09:00 at 08:59:59.999 until the window opens", async () => {
    const owner = await setupUser();
    await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" });
    const email = new FakeEmailProvider();
    // Planned for 09:00, so not claimed before then. The row is due and the window is closed at 08:59:59.999.
    const result = await runSender(depsFor(clockAt("2026-11-10T08:59:59.999Z"), email));
    expect(result.claimed).toBe(0);
    expect(email.calls).toHaveLength(0);
  });

  it("the 21st client message on a user's local day is deferred to the next day's window", async () => {
    const owner = await setupUser({ dailyCap: 20 });
    const invoices: string[] = [];
    for (let i = 0; i < 21; i++) {
      invoices.push((await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" })).invoiceId);
    }
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(20);
    expect(result.deferred).toBe(1);
    expect(email.calls).toHaveLength(20);
    const count = await adminQuery<{ n: string }>("select count(*)::text as n from message_log where user_id = $1", [owner.userId]);
    expect(count.rows[0].n).toBe("20");
    const nextMorning = await adminQuery<{ n: string }>(
      "select count(*)::text as n from scheduled_messages where user_id = $1 and status = 'scheduled' and planned_at = $2",
      [owner.userId, new Date("2026-11-11T09:00:00.000Z")],
    );
    expect(nextMorning.rows[0].n).toBe("1");
    expect(invoices).toHaveLength(21);
  });

  it("the daily cap is counted per the user's local day", async () => {
    const owner = await setupUser({ dailyCap: 1, timezone: "America/New_York" });
    await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" });
    await dueInvoice(owner, { due: "2026-11-10", timezone: "UTC" });
    const email = new FakeEmailProvider();
    // 14:00Z is 09:00 in New York. The window is open, the cap is 1.
    const first = await runSender(depsFor(clockAt("2026-11-10T14:00:00.000Z"), email));
    expect(first.sent).toBe(1);
    // The second message hits the cap inside the same run, so it is deferred to the next local day.
    expect(first.deferred).toBe(1);
    const second = await runSender(depsFor(clockAt("2026-11-10T14:05:00.000Z"), email));
    expect(second.claimed).toBe(0);
    expect(email.calls).toHaveLength(1);
    const deferredTo = await adminQuery<{ n: string }>(
      "select count(*)::text as n from scheduled_messages where user_id = $1 and planned_at = $2 and status = 'scheduled'",
      [owner.userId, new Date("2026-11-11T09:00:00.000Z")],
    );
    expect(deferredTo.rows[0].n).toBe("1");
  });
});

describe("failure mapping", () => {
  it("an incomplete sender profile fails the row and never calls the provider", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    await adminQuery("update settings set business_name = '' where user_id = $1", [owner.userId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.failed).toBe(1);
    expect(email.calls).toHaveLength(0);
    expect((await statusesOf(inv.invoiceId))).toContain("failed");
  });

  it("a missing sending domain fails the row and sends nothing", async () => {
    const owner = await setupUser();
    await dueInvoice(owner);
    await adminQuery("update settings set sending_domain = null where user_id = $1", [owner.userId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.failed).toBe(1);
    expect(email.calls).toHaveLength(0);
  });

  it("a provider refusal marks the row failed, is not resent, and retries only on user request", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const email = new FakeEmailProvider();
    email.nextFailure = "refused";
    const first = await runSender(depsFor(clockAt(NOW), email));
    expect(first.failed).toBe(1);
    expect(email.calls).toHaveLength(1);
    const again = await runSender(depsFor(clockAt("2026-11-10T12:05:00Z"), email));
    expect(again.claimed).toBe(0);
    expect(email.calls).toHaveLength(1);
    const failed = (await rowsOf(inv.invoiceId)).find((r) => r.status === "failed")!;
    await retryFailed(owner.userId, failed.id, clockAt("2026-11-10T12:10:00Z"));
    const retry = await runSender(depsFor(clockAt("2026-11-10T12:10:00Z"), email));
    expect(retry.sent).toBe(1);
    expect(email.calls).toHaveLength(2);
  });

  it("an ambiguous provider outcome leaves the row needs_check and never resends it", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const email = new FakeEmailProvider();
    email.nextFailure = "ambiguous";
    const first = await runSender(depsFor(clockAt(NOW), email));
    expect(first.needsCheck).toBe(1);
    expect(first.sent).toBe(0);
    await runSender(depsFor(clockAt("2026-11-10T12:05:00Z"), email));
    await runSender(depsFor(clockAt("2026-11-10T12:40:00Z"), email));
    expect(email.calls).toHaveLength(1);
    const rows = await rowsOf(inv.invoiceId);
    expect(rows.some((r) => r.status === "needs_check")).toBe(true);
    expect(await eventTypes(inv.invoiceId, "needs_check")).toHaveLength(1);
  });

  it("a sending row older than 15 minutes becomes needs_check and is never resent", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) <= new Date(NOW))!;
    await adminQuery(
      "update scheduled_messages set status = 'sending', claimed_at = $2 where id = $1",
      [row.id, new Date("2026-11-10T11:30:00Z")],
    );
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.needsCheck).toBe(1);
    expect(email.calls).toHaveLength(0);
    expect(await rowStatus(row.id)).toBe("needs_check");
  });

  it("a sending row that is not stale yet is left alone", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled" && new Date(r.planned_at) <= new Date(NOW))!;
    await adminQuery("update scheduled_messages set status = 'sending', claimed_at = $2 where id = $1", [row.id, new Date("2026-11-10T11:55:00Z")]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.needsCheck).toBe(0);
    expect(email.calls).toHaveLength(0);
  });

  it("a row whose timezone is invalid fails without a provider call", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    await adminQuery("update clients set timezone = 'Mars/Olympus' where id = $1", [inv.clientId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.failed).toBe(1);
    expect(email.calls).toHaveLength(0);
  });
});

describe("stops that race a send", () => {
  it("a pause with queued messages results in zero sends for that invoice", async () => {
    const owner = await setupUser();
    const paused = await dueInvoice(owner);
    const live = await dueInvoice(owner);
    await setInvoiceStatus(owner.userId, paused.invoiceId, "paused", clockAt("2026-11-10T11:00:00Z"));
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].subject).not.toBe("");
    const logs = await logsOf(paused.invoiceId);
    expect(logs).toHaveLength(0);
    expect((await statusesOf(live.invoiceId)).includes("sent")).toBe(true);
  });

  it("a pause committed during a batch is never followed by a dispatch for that invoice", async () => {
    const owner = await setupUser();
    const a = await dueInvoice(owner);
    const b = await dueInvoice(owner);
    const calls: OutgoingEmail[] = [];
    let pausing: Promise<void> | null = null;
    const provider: EmailProvider = {
      name: "fake",
      async send(email: OutgoingEmail): Promise<SendResult> {
        calls.push(email);
        if (calls.length === 1) {
          // Issue the pause for the other invoice while this send holds the user's lock.
          const other = email.to === a.email ? b : a;
          pausing = setInvoiceStatus(owner.userId, other.invoiceId, "paused", clockAt("2026-11-10T12:00:01Z"));
        }
        return { providerMessageId: `race_${calls.length}` };
      },
    };
    await runSender({ ...depsFor(clockAt(NOW)), emailFor: async () => provider });
    await pausing;
    const events = await adminQuery<{ id: string; invoice_id: string; type: string; detail: { to?: string } }>(
      "select id, invoice_id, type, detail from events where user_id = $1 order by id", [owner.userId],
    );
    const pauseEvent = events.rows.find((e) => e.type === "status_changed" && e.detail.to === "paused");
    expect(pauseEvent).toBeDefined();
    const pausedInvoice = pauseEvent!.invoice_id;
    const pauseId = Number(pauseEvent!.id);
    const dispatchedAfter = events.rows.filter(
      (e) => e.type === "message_sent" && e.invoice_id === pausedInvoice && Number(e.id) > pauseId,
    );
    expect(dispatchedAfter).toHaveLength(0);
    // Whatever the paused invoice had is cancelled, never sent after the pause.
    const pausedRows = await statusesOf(pausedInvoice);
    expect(pausedRows.filter((s) => s === "scheduled" || s === "pending_approval" || s === "held")).toHaveLength(0);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("a paid invoice has no unsent rows after the commit, and nothing is dispatched afterwards", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    await setInvoiceStatus(owner.userId, inv.invoiceId, "paid", clockAt("2026-11-10T11:00:00Z"));
    const unsent = (await statusesOf(inv.invoiceId)).filter((s) => ["pending_approval", "scheduled", "held"].includes(s));
    expect(unsent).toHaveLength(0);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(0);
  });

  it("a pause issued during an in-flight send waits for it, and nothing is dispatched after the pause commits", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const gate = gatedProvider();
    const gatedRun = runSender({ ...depsFor(clockAt(NOW)), emailFor: async () => gate.provider });
    await gate.startedP;
    let pauseDone = false;
    const pause = setInvoiceStatus(owner.userId, inv.invoiceId, "paused", clockAt("2026-11-10T12:00:01Z")).then(() => {
      pauseDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pauseDone).toBe(false);
    gate.release();
    await gatedRun;
    await pause;
    expect(pauseDone).toBe(true);
    // The send was in flight before the pause. It completes and is logged. Nothing else goes out.
    expect(gate.calls).toHaveLength(1);
    const logs = await logsOf(inv.invoiceId);
    expect(logs).toHaveLength(1);
    const after = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-10T12:30:00Z"), after));
    expect(after.calls).toHaveLength(0);
    expect((await invoiceRow(inv.invoiceId)).status).toBe("paused");
  });

  it("a reply after planning holds the client's due row, and it is not sent", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const clientRow = await adminQuery<{ client_id: string }>("select client_id from invoices where id = $1", [inv.invoiceId]);
    await recordReply({ userId: owner.userId, clientId: clientRow.rows[0].client_id, clock: clockAt("2026-11-10T11:00:00Z") });
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.held).toBe(0);
    expect(result.claimed).toBe(0);
    expect(email.calls).toHaveLength(0);
    await resumeClient({ userId: owner.userId, clientId: clientRow.rows[0].client_id, clock: clockAt("2026-11-10T12:00:00Z") });
    // The due-date step passed while the client was on hold, so it is skipped and never sent late.
    const after = await runSender(depsFor(clockAt("2026-11-10T12:00:00Z"), email));
    expect(after.sent).toBe(0);
    const dueStep = (await rowsOf(inv.invoiceId)).find((r) => new Date(r.planned_at).toISOString() === "2026-11-10T09:00:00.000Z")!;
    expect(dueStep.status).toBe("skipped");
    // Future steps are rescheduled, not dropped.
    expect((await statusesOf(inv.invoiceId)).filter((s) => s === "scheduled")).toHaveLength(2);
  });

  it("a contact held for a bounce at dispatch time is held, not sent", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    await adminQuery("update contacts set hold = 'bounced' where id = $1", [inv.contactId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.claimed).toBe(1);
    expect(result.held).toBe(1);
    expect(email.calls).toHaveLength(0);
  });

  it("a held CC is dropped from the send, and the primary still receives it", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const clientId = (await adminQuery<{ client_id: string }>("select client_id from invoices where id = $1", [inv.invoiceId])).rows[0].client_id;
    const ccId = await addContact(owner.userId, clientId, "billing@acme.example.test");
    await addCc(owner.userId, inv.invoiceId, ccId);
    await adminQuery("update contacts set hold = 'bounced' where id = $1", [ccId]);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].cc).toEqual([]);
    expect(email.calls[0].to).toBe(inv.email);
  });
});

describe("payment links", () => {
  it("creates one link per payable and reuses it; an amount change creates a new link and deactivates the old one", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner);
    const payments = new FakePaymentProvider();
    const email = new FakeEmailProvider();
    const first = await runSender(depsFor(clockAt(NOW), email, payments));
    expect(first.sent).toBe(1);
    expect(payments.createdLinks).toHaveLength(1);
    expect(email.calls[0].text).toContain("https://pay.example.test/plink_fake_1");
    const row = await invoiceRow(inv.invoiceId);
    expect(row.stripe_payment_link_id).toBe("plink_fake_1");
    expect(row.stripe_link_amount_minor).toBe("10000");

    // Second step on the same invoice reuses the link.
    const second = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set planned_at = $2 where id = $1", [second.id, new Date("2026-11-10T11:00:00Z")]);
    await runSender(depsFor(clockAt("2026-11-10T12:20:00Z"), email, payments));
    expect(payments.createdLinks).toHaveLength(1);

    // The amount changes. The next message gets a new link and the old one is deactivated.
    await adminQuery("update invoices set amount_minor = 12000 where id = $1", [inv.invoiceId]);
    const third = (await rowsOf(inv.invoiceId)).find((r) => r.status === "scheduled")!;
    await adminQuery("update scheduled_messages set planned_at = $2 where id = $1", [third.id, new Date("2026-11-10T11:00:00Z")]);
    await runSender(depsFor(clockAt("2026-11-10T12:40:00Z"), email, payments));
    expect(payments.createdLinks).toHaveLength(2);
    expect(payments.createdLinks[1].amountMinor).toBe(12000);
    expect(payments.deactivated).toEqual(["plink_fake_1"]);
  });

  it("a failed link creation marks the row failed and sends nothing", async () => {
    const owner = await setupUser();
    await dueInvoice(owner);
    const payments = new FakePaymentProvider();
    payments.nextFailure = true;
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email, payments));
    expect(result.failed).toBe(1);
    expect(email.calls).toHaveLength(0);
  });

  it("with Stripe connected, the link appears in the message even when the template has no pay_link token", async () => {
    const owner = await setupUser();
    await dueInvoice(owner);
    const payments = new FakePaymentProvider();
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email, payments));
    expect(email.calls[0].text).toContain("https://pay.example.test/");
  });
});

describe("message content", () => {
  it("renders the due date as a calendar date in the client's timezone", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "America/New_York" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-08" });
    await planAt(owner.userId, invoiceId, "2026-11-07T12:00:00Z");
    const email = new FakeEmailProvider();
    // 2026-11-08 09:00 EST is 14:00Z. The window is open at 14:30Z (09:30 local).
    const result = await runSender(depsFor(clockAt("2026-11-08T14:30:00.000Z"), email));
    expect(result.sent).toBe(1);
    expect(email.calls[0].text).toContain("8 Nov 2026");
  });

  it("uses the installment amount and due date for a payment plan message", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
    const invoiceId = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10", amountMinor: 100000, status: "payment_plan" });
    await addInstallments(owner.userId, invoiceId, [
      { due: "2026-11-10", amountMinor: 60000 },
      { due: "2026-12-15", amountMinor: 40000 },
    ]);
    await planAt(owner.userId, invoiceId);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(1);
    expect(email.calls[0].text).toContain("600.00");
    expect(email.calls[0].text).not.toContain("1,000.00");
    expect(email.calls[0].text).toContain("10 Nov 2026");
  });

  it("does not send a message with an unfilled pay_link token when Stripe is not connected", async () => {
    const owner = await setupUser();
    await dueInvoice(owner);
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls[0].text).not.toContain("{pay_link}");
    expect(email.calls[0].text).not.toContain("https://");
  });
});

describe("rule (b) on the first dispatch", () => {
  it("the first sent message to a client releases its other rule (b) rows", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner, { autoSend: false });
    expect((await statusesOf(inv.invoiceId)).filter((s) => s === "pending_approval")).toHaveLength(3);
    const first = (await rowsOf(inv.invoiceId)).find((r) => r.status === "pending_approval" && new Date(r.planned_at).toISOString() === "2026-11-10T09:00:00.000Z")!;
    await approveMessage(owner.userId, first.id, clockAt(NOW));
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.sent).toBe(1);
    const after = await statusesOf(inv.invoiceId);
    expect(after.filter((s) => s === "pending_approval")).toHaveLength(0);
    expect(after.filter((s) => s === "scheduled")).toHaveLength(2);
  });

  it("an approval-gated row never dispatches until it is approved", async () => {
    const owner = await setupUser();
    const inv = await dueInvoice(owner, { autoSend: true });
    await adminQuery("update scheduled_messages set status = 'pending_approval', requires_approval = true where invoice_id = $1 and status = 'scheduled'", [inv.invoiceId]);
    const email = new FakeEmailProvider();
    const result = await runSender(depsFor(clockAt(NOW), email));
    expect(result.claimed).toBe(0);
    expect(email.calls).toHaveLength(0);
    const row = (await rowsOf(inv.invoiceId)).find((r) => r.status === "pending_approval")!;
    await approveMessage(owner.userId, row.id, clockAt(NOW));
    await runSender(depsFor(clockAt(NOW), email));
    expect(email.calls).toHaveLength(1);
  });
});

