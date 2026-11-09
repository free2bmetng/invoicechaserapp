// Client and contact writes. Every write takes the user's lock, and every query is
// filtered by user_id. A client's email is stored lower-cased and is unique per user.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { InvalidStateError, NotFoundError, ValidationError } from "./errors";
import { applyAutoSendTx } from "./client";
import { planInvoiceTx } from "./plan";
import * as S from "./store";
import { logEvent } from "./store";
import { cleanName, normalizeEmail } from "./validate";
import { assertValidZone } from "./window";
import { releaseHeld } from "./store";

export interface ClientInput {
  name: string;
  email: string;
  timezone?: string | null;
  sequenceId?: string | null;
  autoSend?: boolean;
}

export interface ClientPatch {
  name?: string;
  email?: string;
  timezone?: string | null;
  sequenceId?: string | null;
  autoSend?: boolean;
}

export interface ContactInput {
  id?: string;
  email: string;
  name: string;
  isPrimary: boolean;
}

export interface ClientCreated {
  clientId: string;
  contactId: string;
}

export async function assertStandardSequence(c: PoolClient, userId: string, sequenceId: string): Promise<void> {
  const { rows } = await c.query<{ kind: string }>(
    "select kind from sequences where id = $1 and user_id = $2",
    [sequenceId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Sequence");
  if (rows[0].kind !== "standard") throw new ValidationError("A client or invoice can only use a standard sequence.");
}

export async function clientByEmail(c: PoolClient, userId: string, email: string): Promise<{ id: string } | null> {
  const { rows } = await c.query<{ id: string }>("select id from clients where user_id = $1 and email = $2", [userId, email]);
  return rows[0] ?? null;
}

// Invoices of a client that can still produce messages.
export async function generatingInvoiceIds(c: PoolClient, userId: string, clientId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    "select id from invoices where user_id = $1 and client_id = $2 and status in ('open', 'payment_plan') order by id",
    [userId, clientId],
  );
  return rows.map((r) => r.id);
}

export async function createClient(userId: string, input: ClientInput, clock: Clock): Promise<ClientCreated> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const name = cleanName(input.name, "Client name");
    const email = normalizeEmail(input.email);
    if (input.timezone) assertValidZone(input.timezone);
    if (input.sequenceId) await assertStandardSequence(c, userId, input.sequenceId);
    if (await clientByEmail(c, userId, email)) throw new ValidationError("A client with this email already exists.");

    const created = await c.query<{ id: string }>(
      `insert into clients (user_id, name, email, timezone, sequence_id, auto_send)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [userId, name, email, input.timezone || null, input.sequenceId ?? null, input.autoSend ?? false],
    );
    const clientId = created.rows[0].id;
    const contact = await c.query<{ id: string }>(
      `insert into contacts (user_id, client_id, email, name, is_primary) values ($1, $2, $3, $4, true) returning id`,
      [userId, clientId, email, name],
    );
    await logEvent(c, { userId, clientId, type: "client_created", detail: {}, at });
    return { clientId, contactId: contact.rows[0].id };
  });
}

export async function updateClient(userId: string, clientId: string, patch: ClientPatch, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const client = await S.loadClient(c, userId, clientId);
    const changed: string[] = [];
    let replan = false;

    if (patch.name !== undefined) {
      const name = cleanName(patch.name, "Client name");
      await c.query("update clients set name = $3 where id = $1 and user_id = $2", [clientId, userId, name]);
      changed.push("name");
    }

    if (patch.email !== undefined) {
      const email = normalizeEmail(patch.email);
      if (email !== client.email) {
        const other = await clientByEmail(c, userId, email);
        if (other && other.id !== clientId) throw new ValidationError("A client with this email already exists.");
        // The primary contact follows the client's address when it was the same address.
        const primary = await S.primaryContactOfClient(c, userId, clientId);
        if (primary && primary.email === client.email) {
          const clash = await c.query(
            "select id from contacts where user_id = $1 and client_id = $2 and email = $3 and id <> $4",
            [userId, clientId, email, primary.id],
          );
          if (clash.rows[0]) throw new ValidationError("Another contact of this client already uses that address.");
          await c.query("update contacts set email = $3 where id = $1 and user_id = $2", [primary.id, userId, email]);
        }
        await c.query("update clients set email = $3 where id = $1 and user_id = $2", [clientId, userId, email]);
        changed.push("email");
      }
    }

    if (patch.timezone !== undefined) {
      const tz = patch.timezone || null;
      if (tz) assertValidZone(tz);
      await c.query("update clients set timezone = $3 where id = $1 and user_id = $2", [clientId, userId, tz]);
      changed.push("timezone");
      replan = true;
    }

    if (patch.sequenceId !== undefined) {
      if (patch.sequenceId) await assertStandardSequence(c, userId, patch.sequenceId);
      await c.query("update clients set sequence_id = $3 where id = $1 and user_id = $2", [clientId, userId, patch.sequenceId ?? null]);
      changed.push("sequenceId");
      replan = true;
    }

    if (patch.autoSend !== undefined) {
      await applyAutoSendTx(c, userId, clientId, patch.autoSend, at);
      changed.push("autoSend");
    }

    if (replan) {
      for (const invoiceId of await generatingInvoiceIds(c, userId, clientId)) {
        await planInvoiceTx(c, userId, invoiceId, at);
      }
    }
    if (changed.length > 0) {
      await logEvent(c, { userId, clientId, type: "client_updated", detail: { changed }, at });
    }
  });
}

// Adds a contact or updates one. Exactly one primary contact per client.
export async function upsertContact(userId: string, clientId: string, input: ContactInput, clock: Clock): Promise<{ contactId: string }> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    await S.loadClient(c, userId, clientId);
    const email = normalizeEmail(input.email, "Contact email");
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";

    let existing: S.ContactRow | null = null;
    if (input.id) {
      existing = await S.loadContact(c, userId, input.id);
      if (!existing || existing.client_id !== clientId) throw new NotFoundError("Contact");
    }
    const clash = await c.query<{ id: string }>(
      "select id from contacts where user_id = $1 and client_id = $2 and email = $3 and id <> $4",
      [userId, clientId, email, existing?.id ?? "00000000-0000-0000-0000-000000000000"],
    );
    if (clash.rows[0]) throw new ValidationError("This client already has a contact with that address.");

    if (input.isPrimary) {
      await c.query(
        "update contacts set is_primary = false where user_id = $1 and client_id = $2 and is_primary and id <> $3",
        [userId, clientId, existing?.id ?? "00000000-0000-0000-0000-000000000000"],
      );
    } else if (existing?.is_primary) {
      throw new ValidationError("A client needs a primary contact. Make another contact primary instead.");
    }

    if (existing) {
      await c.query(
        "update contacts set email = $3, name = $4, is_primary = $5 where id = $1 and user_id = $2",
        [existing.id, userId, email, name, input.isPrimary],
      );
      await logEvent(c, { userId, clientId, type: "contact_updated", detail: { contact_id: existing.id }, at });
      return { contactId: existing.id };
    }
    const created = await c.query<{ id: string }>(
      `insert into contacts (user_id, client_id, email, name, is_primary) values ($1, $2, $3, $4, $5) returning id`,
      [userId, clientId, email, name, input.isPrimary],
    );
    await logEvent(c, { userId, clientId, type: "contact_added", detail: { contact_id: created.rows[0].id }, at });
    return { contactId: created.rows[0].id };
  });
}

// Removes a contact. The primary cannot be removed. A contact with sent or in-flight
// messages cannot be removed, because its history would be lost. Its invoice roles and
// unsent rows move to the client's primary contact. Held rows are then re-evaluated.
export async function removeContact(userId: string, contactId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const contact = await S.loadContact(c, userId, contactId);
    if (!contact) throw new NotFoundError("Contact");
    if (contact.is_primary) throw new ValidationError("Choose another primary contact before removing this one.");

    const busy = await c.query<{ n: string }>(
      `select count(*)::text as n from scheduled_messages
       where contact_id = $1 and user_id = $2 and status in ('sending', 'sent', 'delivered', 'bounced', 'needs_check')`,
      [contactId, userId],
    );
    if (Number(busy.rows[0].n) > 0) {
      throw new InvalidStateError("This contact has sent or in-flight messages, so it cannot be removed.");
    }

    const primary = await S.primaryContactOfClient(c, userId, contact.client_id);
    if (!primary) throw new InvalidStateError("The client has no primary contact to move messages to.");

    // Invoice roles: a primary role moves to the client's primary, a cc role is dropped.
    const roles = await c.query<{ invoice_id: string; role: string }>(
      "select invoice_id, role from invoice_contacts where contact_id = $1 and user_id = $2",
      [contactId, userId],
    );
    for (const r of roles.rows) {
      if (r.role === "primary") {
        await c.query(
          "delete from invoice_contacts where invoice_id = $1 and contact_id = $2 and user_id = $3",
          [r.invoice_id, primary.id, userId],
        );
        await c.query(
          "update invoice_contacts set contact_id = $3 where invoice_id = $1 and contact_id = $2 and user_id = $4",
          [r.invoice_id, contactId, primary.id, userId],
        );
      } else {
        await c.query(
          "delete from invoice_contacts where invoice_id = $1 and contact_id = $2 and user_id = $3",
          [r.invoice_id, contactId, userId],
        );
      }
    }

    // Unsent and cancelled rows now address the primary contact.
    await c.query(
      `update scheduled_messages set contact_id = $3, updated_at = $4
       where contact_id = $1 and user_id = $2 and status not in ('sending', 'sent', 'delivered', 'bounced', 'needs_check')`,
      [contactId, userId, primary.id, at],
    );
    await c.query("delete from contacts where id = $1 and user_id = $2", [contactId, userId]);
    await logEvent(c, { userId, clientId: contact.client_id, type: "contact_removed", detail: { contact_id: contactId }, at });
    // Rows held for the removed address would otherwise be stranded. Release those the primary no longer holds.
    await releaseHeld(c, userId, { contactId: primary.id }, at);
  });
}

