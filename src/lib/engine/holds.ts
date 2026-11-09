// Holds and provider feedback. Bounces, replies and resumes are idempotent and
// monotonic: a delivery report can move a row sent -> delivered, and a bounce can
// move sent or delivered -> bounced. Nothing moves back to an earlier state.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withService, withUser } from "@/lib/db";
import * as S from "./store";
import { NotFoundError } from "./errors";

interface LogRow {
  id: string;
  user_id: string;
  scheduled_message_id: string;
  recipient_email: string;
  delivery_status: string;
}

// Maps a provider message to its owner. Runs as the service role, so every
// later query filters by the user it finds here.
async function findOwner(provider: string, providerMessageId: string): Promise<string | null> {
  return withService(async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      "select user_id from message_log where provider = $1 and provider_message_id = $2",
      [provider, providerMessageId],
    );
    return rows[0]?.user_id ?? null;
  });
}

async function lockLog(c: PoolClient, userId: string, provider: string, providerMessageId: string): Promise<LogRow | null> {
  const { rows } = await c.query<LogRow>(
    `select id, user_id, scheduled_message_id, recipient_email, delivery_status from message_log
     where user_id = $1 and provider = $2 and provider_message_id = $3 for update`,
    [userId, provider, providerMessageId],
  );
  return rows[0] ?? null;
}

// Holds every unsent row sent to this address, across the user's invoices.
async function holdAddressTx(c: PoolClient, userId: string, address: string, at: Date): Promise<void> {
  const addr = address.trim().toLowerCase();
  const { rows: contacts } = await c.query<{ id: string; hold: string | null }>(
    "select id, hold from contacts where user_id = $1 and email = $2 for update",
    [userId, addr],
  );
  if (contacts.length === 0) return;
  for (const contact of contacts) {
    if (contact.hold === "bounced") continue;
    await c.query("update contacts set hold = 'bounced' where id = $1 and user_id = $2", [contact.id, userId]);
    await S.logEvent(c, { userId, type: "contact_held", detail: { contact_id: contact.id, reason: "bounce" }, at });
  }
  const { rows } = await c.query<S.MessageRow>(
    `${S.MESSAGE_SELECT} where user_id = $1 and contact_id = any($2::uuid[])
       and status in ('pending_approval', 'scheduled') order by id for update`,
    [userId, contacts.map((x) => x.id)],
  );
  for (const row of rows) await S.holdForReason(c, userId, row, "bounce", at);
}

// The bounce transition. A repeated bounce, or one after a bounce, changes nothing.
async function bounceTx(c: PoolClient, userId: string, log: LogRow, recipient: string | null, at: Date): Promise<void> {
  if (log.delivery_status === "bounced") return;
  await c.query("update message_log set delivery_status = 'bounced' where id = $1 and user_id = $2", [log.id, userId]);
  const msg = await S.loadMessage(c, userId, log.scheduled_message_id, true);
  // Only a row that was sent or delivered becomes bounced. Other states stay as they are.
  if (msg && (msg.status === "sent" || msg.status === "delivered")) {
    await S.updateMessage(c, userId, msg.id, { status: "bounced" }, at);
    await S.logEvent(c, { userId, invoiceId: msg.invoice_id, type: "message_bounced", detail: { scheduled_message_id: msg.id }, at });
  }
  await holdAddressTx(c, userId, recipient ?? log.recipient_email, at);
}

export interface BounceArgs {
  provider: string;
  providerMessageId: string;
  clock: Clock;
  // Optional: the address the provider reported. Defaults to the primary recipient.
  recipient?: string;
}

export async function recordBounce(args: BounceArgs): Promise<void> {
  const { provider, providerMessageId, clock, recipient } = args;
  const userId = await findOwner(provider, providerMessageId);
  if (!userId) return;
  await withService(async (c) => {
    await S.lockUser(c, userId);
    const log = await lockLog(c, userId, provider, providerMessageId);
    if (!log) return;
    await bounceTx(c, userId, log, recipient ?? null, clock.now());
  });
}

export interface DeliveryStatusArgs {
  provider: string;
  providerMessageId: string;
  status: "delivered" | "bounced" | "failed";
  clock: Clock;
}

export async function recordDeliveryStatus(args: DeliveryStatusArgs): Promise<void> {
  const { provider, providerMessageId, status, clock } = args;
  const userId = await findOwner(provider, providerMessageId);
  if (!userId) return;
  await withService(async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const log = await lockLog(c, userId, provider, providerMessageId);
    if (!log) return;

    if (status === "bounced") {
      await bounceTx(c, userId, log, null, at);
      return;
    }
    // Only a sent message can move forward to delivered or failed.
    if (log.delivery_status !== "sent") return;
    await c.query(
      "update message_log set delivery_status = $3 where id = $1 and user_id = $2",
      [log.id, userId, status],
    );
    const msg = await S.loadMessage(c, userId, log.scheduled_message_id, true);
    if (status === "delivered" && msg && msg.status === "sent") {
      await S.updateMessage(c, userId, msg.id, { status: "delivered" }, at);
    }
    await S.logEvent(c, {
      userId,
      invoiceId: msg?.invoice_id ?? null,
      type: status === "delivered" ? "message_delivered" : "delivery_failed",
      detail: { scheduled_message_id: log.scheduled_message_id },
      at,
    });
  });
}

// Reply: every unsent row for the client, across invoices, is held until the user resumes.
export async function recordReply(args: { userId: string; clientId: string; clock: Clock }): Promise<void> {
  const { userId, clientId, clock } = args;
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const client = await S.loadClient(c, userId, clientId);
    if (client.reply_held_at === null) {
      await c.query("update clients set reply_held_at = $3 where id = $1 and user_id = $2", [clientId, userId, at]);
      await S.logEvent(c, { userId, clientId, type: "client_replied", detail: {}, at });
    }
    const { rows } = await c.query<S.MessageRow>(
      `${S.MESSAGE_SELECT} m where m.user_id = $1 and m.status in ('pending_approval', 'scheduled')
         and m.invoice_id in (select id from invoices where client_id = $2 and user_id = $1)
       order by m.id for update`,
      [userId, clientId],
    );
    for (const row of rows) await S.holdForReason(c, userId, row, "reply", at);
  });
}

export async function resumeContact(args: { userId: string; contactId: string; clock: Clock }): Promise<void> {
  const { userId, contactId, clock } = args;
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const contact = await S.loadContact(c, userId, contactId);
    if (!contact) throw new NotFoundError("Contact");
    if (contact.hold !== null) {
      await c.query("update contacts set hold = null where id = $1 and user_id = $2", [contactId, userId]);
      await S.logEvent(c, { userId, type: "contact_resumed", detail: { contact_id: contactId }, at });
    }
    await S.releaseHeld(c, userId, { contactId }, at);
  });
}

export async function holdContact(args: { userId: string; contactId: string; clock: Clock }): Promise<void> {
  const { userId, contactId, clock } = args;
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const contact = await S.loadContact(c, userId, contactId);
    if (!contact) throw new NotFoundError("Contact");
    if (contact.hold === null) {
      await c.query("update contacts set hold = 'paused' where id = $1 and user_id = $2", [contactId, userId]);
      await S.logEvent(c, { userId, type: "contact_held", detail: { contact_id: contactId, reason: "paused" }, at });
    }
    const { rows } = await c.query<S.MessageRow>(
      `${S.MESSAGE_SELECT} where user_id = $1 and contact_id = $2 and status in ('pending_approval', 'scheduled') order by id for update`,
      [userId, contactId],
    );
    for (const row of rows) await S.holdForReason(c, userId, row, "contact_paused", at);
  });
}

export async function resumeClient(args: { userId: string; clientId: string; clock: Clock }): Promise<void> {
  const { userId, clientId, clock } = args;
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const client = await S.loadClient(c, userId, clientId);
    if (client.reply_held_at !== null) {
      await c.query("update clients set reply_held_at = null where id = $1 and user_id = $2", [clientId, userId]);
      await S.logEvent(c, { userId, clientId, type: "client_resumed", detail: {}, at });
    }
    await S.releaseHeld(c, userId, { clientId }, at);
  });
}
