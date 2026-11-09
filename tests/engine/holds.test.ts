// Holds and provider feedback: bounces, delivery reports, replies and resume.
// Bounces and delivery reports are monotonic and idempotent, including under concurrency.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, adminQuery } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  holdMessage,
  listNeedsYou,
  recordBounce,
  recordDeliveryStatus,
  recordReply,
  resumeClient,
  resumeContact,
  resumeMessage,
  runSender,
  setInvoiceStatus,
  holdContact,
  ValidationError,
} from "@/lib/engine";
import {
  NOW,
  addClient,
  addInvoice,
  clockAt,
  depsFor,
  eventTypes,
  planAt,
  rowsOf,
  rowStatus,
  setupUser,
  statusesOf,
  logsOf,
  type Owner,
} from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

// One client with two invoices. Invoice A's due step is sent, invoice B's rows are all still unsent.
async function twoInvoicesOneSent(owner: Owner) {
  const client = await addClient(owner.userId, { autoSend: true, timezone: "UTC" });
  const a = await addInvoice(owner.userId, client.clientId, { due: "2026-11-10" });
  const b = await addInvoice(owner.userId, client.clientId, { due: "2026-12-01" });
  await planAt(owner.userId, a);
  await planAt(owner.userId, b);
  const email = new FakeEmailProvider();
  await runSender(depsFor(clockAt(NOW), email));
  const log = await logsOf(a);
  return { clientId: client.clientId, contactId: client.contactId, a, b, email, providerId: log[0].provider_message_id! };
}

// The row behind the single sent message of an invoice.
async function sentRowOf(invoiceId: string) {
  const log = await logsOf(invoiceId);
  const rows = await rowsOf(invoiceId);
  return rows.find((r) => r.id === log[0].scheduled_message_id)!;
}

describe("bounces", () => {
  it("a bounce marks the message bounced, holds the address across invoices, and raises a Needs you item", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    expect((await sentRowOf(s.a)).status).toBe("bounced");
    const contact = await adminQuery<{ hold: string }>("select hold from contacts where id = $1", [s.contactId]);
    expect(contact.rows[0].hold).toBe("bounced");
    const bRows = await statusesOf(s.b);
    expect(bRows.filter((x) => x === "held")).toHaveLength(4);
    const log = await adminQuery<{ delivery_status: string }>("select delivery_status from message_log where provider_message_id = $1", [s.providerId]);
    expect(log.rows[0].delivery_status).toBe("bounced");
    const items = await listNeedsYou(owner.userId);
    expect(items.some((i) => i.kind === "bounce" && i.contactId === s.contactId)).toBe(true);
  });

  it("a bounce for an unknown message is a no-op", async () => {
    const owner = await setupUser();
    const count = async () => (await adminQuery<{ n: string }>("select count(*)::text as n from events where user_id = $1", [owner.userId])).rows[0].n;
    const before = await count();
    await recordBounce({ provider: "fake", providerMessageId: "fake_does_not_exist", clock: clockAt(NOW) });
    expect(await count()).toBe(before);
  });

  it("a repeated bounce changes nothing, even after the user resumed the contact", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    await resumeContact({ userId: owner.userId, contactId: s.contactId, clock: clockAt("2026-11-10T12:06:00Z") });
    const before = await adminQuery<{ n: string }>("select count(*)::text as n from events where user_id = $1", [owner.userId]);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:07:00Z") });
    const after = await adminQuery<{ n: string }>("select count(*)::text as n from events where user_id = $1", [owner.userId]);
    const contact = await adminQuery<{ hold: string | null }>("select hold from contacts where id = $1", [s.contactId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(contact.rows[0].hold).toBeNull();
  });

  it("concurrent bounces for the same message produce one bounce event and one contact hold", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await Promise.all([
      recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") }),
      recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:01Z") }),
    ]);
    expect(await eventTypes(s.a, "message_bounced")).toHaveLength(1);
    expect((await adminQuery("select id from events where user_id = $1 and type = 'contact_held'", [owner.userId])).rows).toHaveLength(1);
  });

  it("a late delivered report does not reset a bounced row", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:06:00Z") });
    const row = await sentRowOf(s.a);
    expect(row.status).toBe("bounced");
  });

  it("a bounce does not overwrite a cancelled row", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await setInvoiceStatus(owner.userId, s.b, "paused", clockAt("2026-11-10T12:01:00Z"));
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    expect((await statusesOf(s.b)).every((x) => x === "cancelled" || x === "skipped")).toBe(true);
  });

  it("a bounce released on resume of the contact sends nothing until the contact is resumed", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    const email = new FakeEmailProvider();
    await runSender(depsFor(clockAt("2026-11-12T12:00:00Z"), email));
    expect(email.calls).toHaveLength(0);
    await resumeContact({ userId: owner.userId, contactId: s.contactId, clock: clockAt("2026-11-12T12:00:00Z") });
    expect((await statusesOf(s.b)).filter((x) => x === "scheduled")).toHaveLength(4);
  });
});

describe("delivery status", () => {
  it("moves a sent message to delivered, and a repeated delivered report is a no-op", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:05:00Z") });
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:06:00Z") });
    const row = await sentRowOf(s.a);
    expect(row.status).toBe("delivered");
    expect((await logsOf(s.a))[0].delivery_status).toBe("delivered");
  });

  it("a bounce after delivered is still applied, and then nothing moves it back", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:05:00Z") });
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "bounced", clock: clockAt("2026-11-10T12:06:00Z") });
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:07:00Z") });
    const row = await sentRowOf(s.a);
    expect(row.status).toBe("bounced");
  });

  it("concurrent delivered and bounced reports end bounced in either order", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await Promise.all([
      recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "delivered", clock: clockAt("2026-11-10T12:05:00Z") }),
      recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "bounced", clock: clockAt("2026-11-10T12:05:00Z") }),
    ]);
    const row = await sentRowOf(s.a);
    expect(row.status).toBe("bounced");
  });

  it("a failed delivery report is recorded on the log and changes no row status", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordDeliveryStatus({ provider: "fake", providerMessageId: s.providerId, status: "failed", clock: clockAt("2026-11-10T12:05:00Z") });
    expect((await logsOf(s.a))[0].delivery_status).toBe("failed");
    const row = await sentRowOf(s.a);
    expect(row.status).toBe("sent");
  });
});

describe("replies", () => {
  it("a reply holds every unsent row of the client across invoices and raises a Needs you item", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordReply({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:05:00Z") });
    expect((await statusesOf(s.b)).every((x) => x === "held")).toBe(true);
    const items = await listNeedsYou(owner.userId);
    expect(items.some((i) => i.kind === "reply" && i.clientId === s.clientId)).toBe(true);
    const client = await adminQuery<{ reply_held_at: Date | null }>("select reply_held_at from clients where id = $1", [s.clientId]);
    expect(client.rows[0].reply_held_at).not.toBeNull();
  });

  it("resuming the client reschedules future rows and skips the ones whose time has passed", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordReply({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:05:00Z") });
    await resumeClient({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:30:00Z") });
    const statuses = await statusesOf(s.b);
    expect(statuses.filter((x) => x === "scheduled")).toHaveLength(4);
  });

  it("resuming the client keeps rows held by a bounced contact", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordBounce({ provider: "fake", providerMessageId: s.providerId, clock: clockAt("2026-11-10T12:05:00Z") });
    await recordReply({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:06:00Z") });
    await resumeClient({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:30:00Z") });
    expect((await statusesOf(s.b)).every((x) => x === "held")).toBe(true);
  });

  it("a held row awaiting approval stays pending approval on resume", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId, { autoSend: false, timezone: "UTC" });
    const inv = await addInvoice(owner.userId, client.clientId, { due: "2026-12-01" });
    await planAt(owner.userId, inv);
    await recordReply({ userId: owner.userId, clientId: client.clientId, clock: clockAt("2026-11-10T12:05:00Z") });
    await resumeClient({ userId: owner.userId, clientId: client.clientId, clock: clockAt("2026-11-10T12:30:00Z") });
    const statuses = await statusesOf(inv);
    expect(statuses.filter((x) => x === "pending_approval")).toHaveLength(4);
  });

  it("a user hold is not released by resuming the client", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    const row = (await rowsOf(s.b)).find((r) => r.status === "scheduled")!;
    await holdMessage(owner.userId, row.id, clockAt("2026-11-10T12:05:00Z"));
    await recordReply({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:06:00Z") });
    await resumeClient({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:30:00Z") });
    expect(await rowStatus(row.id)).toBe("held");
  });

  it("a held message cannot be resumed while its client is on reply hold", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await recordReply({ userId: owner.userId, clientId: s.clientId, clock: clockAt("2026-11-10T12:05:00Z") });
    const row = (await rowsOf(s.b)).find((r) => r.status === "held")!;
    await expect(resumeMessage(owner.userId, row.id, clockAt("2026-11-10T12:10:00Z"))).rejects.toBeInstanceOf(ValidationError);
  });

  it("holding a contact holds its rows, and resuming it reschedules them", async () => {
    const owner = await setupUser();
    const s = await twoInvoicesOneSent(owner);
    await holdContact({ userId: owner.userId, contactId: s.contactId, clock: clockAt("2026-11-10T12:05:00Z") });
    expect((await statusesOf(s.b)).every((x) => x === "held")).toBe(true);
    await resumeContact({ userId: owner.userId, contactId: s.contactId, clock: clockAt("2026-11-10T12:10:00Z") });
    expect((await statusesOf(s.b)).filter((x) => x === "scheduled")).toHaveLength(4);
  });
});

