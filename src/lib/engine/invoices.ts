// Invoice writes: create, edit, contacts, the CSV commit path, and a bulk planner.
// Every write runs under the user's lock. Paid and written-off invoices are final.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { EngineError, InvalidStateError, ValidationError } from "./errors";
import { assertStandardSequence, clientByEmail, generatingInvoiceIds } from "./clients";
import { planInvoiceTx } from "./plan";
import * as S from "./store";
import { logEvent } from "./store";
import { validateInstallments } from "./installments";
import {
  assertDueNotBeforeIssue,
  cleanAmountMinor,
  cleanCurrency,
  cleanInvoiceNumber,
  cleanIsoDate,
  cleanName,
  normalizeEmail,
} from "./validate";

export interface InvoiceContacts {
  primaryContactId: string;
  ccContactIds: string[];
}

export interface InvoiceInput {
  clientId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  sequenceId?: string | null;
  // Defaults to the client's primary contact, with no cc contacts.
  contacts?: InvoiceContacts;
  source?: "manual" | "csv" | "stripe";
  externalId?: string | null;
}

export interface InvoicePatch {
  invoiceNumber?: string;
  amountMinor?: number;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string;
  sequenceId?: string | null;
  contacts?: InvoiceContacts;
}

export interface ImportInvoiceRow {
  line?: number;
  clientName: string;
  clientEmail: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  issueDate: string;
  dueDate: string;
}

export interface ImportResult {
  created: number;
  duplicates: number;
  clientsCreated: number;
  rejected: { line: number; reason: string }[];
}

const FINAL_STATUSES = ["paid", "written_off"];

async function assertContacts(c: PoolClient, userId: string, clientId: string, contacts: InvoiceContacts): Promise<void> {
  const primary = await S.loadContact(c, userId, contacts.primaryContactId);
  if (!primary || primary.client_id !== clientId) throw new ValidationError("The primary contact must belong to this client.");
  const cc = [...new Set(contacts.ccContactIds)];
  if (cc.includes(primary.id)) throw new ValidationError("The primary contact cannot also be a cc contact.");
  for (const id of cc) {
    const row = await S.loadContact(c, userId, id);
    if (!row || row.client_id !== clientId) throw new ValidationError("Cc contacts must belong to this client.");
  }
}

async function rewriteInvoiceContacts(c: PoolClient, userId: string, invoiceId: string, contacts: InvoiceContacts): Promise<void> {
  await c.query("delete from invoice_contacts where invoice_id = $1 and user_id = $2", [invoiceId, userId]);
  await c.query(
    "insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'primary')",
    [userId, invoiceId, contacts.primaryContactId],
  );
  for (const id of [...new Set(contacts.ccContactIds)]) {
    if (id === contacts.primaryContactId) continue;
    await c.query("insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'cc')", [userId, invoiceId, id]);
  }
}

async function clientPrimary(c: PoolClient, userId: string, clientId: string): Promise<S.ContactRow> {
  const primary = await S.primaryContactOfClient(c, userId, clientId);
  if (!primary) throw new ValidationError("This client has no primary contact yet.");
  return primary;
}

async function duplicateNumber(c: PoolClient, userId: string, clientId: string, number: string, exceptId: string | null): Promise<boolean> {
  const { rows } = await c.query<{ id: string }>(
    "select id from invoices where user_id = $1 and client_id = $2 and invoice_number = $3 and id <> $4",
    [userId, clientId, number, exceptId ?? "00000000-0000-0000-0000-000000000000"],
  );
  return rows.length > 0;
}

export async function createInvoice(userId: string, input: InvoiceInput, clock: Clock): Promise<{ invoiceId: string }> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const client = await S.loadClient(c, userId, input.clientId);
    const number = cleanInvoiceNumber(input.invoiceNumber);
    const amount = cleanAmountMinor(input.amountMinor);
    const currency = cleanCurrency(input.currency);
    const issueDate = cleanIsoDate(input.issueDate, "Issue date");
    const dueDate = cleanIsoDate(input.dueDate, "Due date");
    assertDueNotBeforeIssue(issueDate, dueDate);
    if (await duplicateNumber(c, userId, client.id, number, null)) {
      throw new ValidationError(`This client already has invoice ${number}.`);
    }
    if (input.sequenceId) await assertStandardSequence(c, userId, input.sequenceId);
    const contacts = input.contacts ?? { primaryContactId: (await clientPrimary(c, userId, client.id)).id, ccContactIds: [] };
    await assertContacts(c, userId, client.id, contacts);

    const created = await c.query<{ id: string }>(
      `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status,
         notes, sequence_id, source, external_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12) returning id`,
      [userId, client.id, number, amount, currency, issueDate, dueDate, input.notes ?? "",
        input.sequenceId ?? null, input.source ?? "manual", input.externalId ?? null, at],
    );
    const invoiceId = created.rows[0].id;
    await rewriteInvoiceContacts(c, userId, invoiceId, contacts);
    await logEvent(c, { userId, invoiceId, clientId: client.id, type: "invoice_created", detail: { source: input.source ?? "manual" }, at });
    await planInvoiceTx(c, userId, invoiceId, at);
    return { invoiceId };
  });
}

export async function updateInvoice(userId: string, invoiceId: string, patch: InvoicePatch, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const inv = await S.loadInvoice(c, userId, invoiceId);
    if (FINAL_STATUSES.includes(inv.status)) {
      throw new InvalidStateError("Paid and written-off invoices cannot be edited.");
    }
    const changed: string[] = [];
    const number = patch.invoiceNumber !== undefined ? cleanInvoiceNumber(patch.invoiceNumber) : inv.invoice_number;
    const amount = patch.amountMinor !== undefined ? cleanAmountMinor(patch.amountMinor) : inv.amount_minor;
    const currency = patch.currency !== undefined ? cleanCurrency(patch.currency) : inv.currency;
    const issueDate = patch.issueDate !== undefined ? cleanIsoDate(patch.issueDate, "Issue date") : inv.issue_date;
    const dueDate = patch.dueDate !== undefined ? cleanIsoDate(patch.dueDate, "Due date") : inv.due_date;
    assertDueNotBeforeIssue(issueDate, dueDate);
    const notes = patch.notes !== undefined ? String(patch.notes) : undefined;
    const sequenceId = patch.sequenceId !== undefined ? patch.sequenceId : inv.sequence_id;

    if (number !== inv.invoice_number) {
      if (await duplicateNumber(c, userId, inv.client_id, number, invoiceId)) {
        throw new ValidationError(`This client already has invoice ${number}.`);
      }
    }
    if (sequenceId && sequenceId !== inv.sequence_id) await assertStandardSequence(c, userId, sequenceId);

    const installments = await S.installmentsOf(c, userId, invoiceId);
    if (installments.length > 0 && amount !== inv.amount_minor) {
      const check = validateInstallments(amount, installments.map((i) => ({ dueDate: i.due_date, amountMinor: i.amount_minor })));
      if (!check.ok) {
        throw new ValidationError(`Change the payment plan first: ${check.errors.join(" ")}`);
      }
    }
    if (patch.contacts) await assertContacts(c, userId, inv.client_id, patch.contacts);

    await c.query(
      `update invoices set invoice_number = $3, amount_minor = $4, currency = $5, issue_date = $6, due_date = $7,
         notes = coalesce($8, notes), sequence_id = $9, updated_at = $10
       where id = $1 and user_id = $2`,
      [invoiceId, userId, number, amount, currency, issueDate, dueDate, notes ?? null, sequenceId, at],
    );
    if (currency !== inv.currency) {
      // Unpaid installments take the new currency. Paid ones keep the currency they were paid in.
      await c.query(
        "update payment_plan_installments set currency = $3 where invoice_id = $1 and user_id = $2 and status = 'open'",
        [invoiceId, userId, currency],
      );
    }
    if (patch.contacts) await rewriteInvoiceContacts(c, userId, invoiceId, patch.contacts);

    for (const [field, before, after] of [
      ["invoiceNumber", inv.invoice_number, number],
      ["amountMinor", inv.amount_minor, amount],
      ["currency", inv.currency, currency],
      ["issueDate", inv.issue_date, issueDate],
      ["dueDate", inv.due_date, dueDate],
      ["sequenceId", inv.sequence_id, sequenceId],
    ] as const) {
      if (before !== after) changed.push(field);
    }
    if (notes !== undefined && notes !== inv.notes) changed.push("notes");
    if (patch.contacts) changed.push("contacts");

    // Due date, sequence and contacts change the planned rows. Amount and currency do not:
    // the sender reads them at send time, and a changed amount or currency gets a new link.
    const replan = inv.due_date !== dueDate || inv.sequence_id !== sequenceId || patch.contacts !== undefined;
    if (replan && (await generatingInvoiceIds(c, userId, inv.client_id)).includes(invoiceId)) {
      await planInvoiceTx(c, userId, invoiceId, at);
    }
    if (changed.length > 0) {
      await logEvent(c, { userId, invoiceId, clientId: inv.client_id, type: "invoice_updated", detail: { changed }, at });
    }
  });
}

export async function setInvoiceContacts(
  userId: string,
  invoiceId: string,
  contacts: InvoiceContacts,
  clock: Clock,
): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const inv = await S.loadInvoice(c, userId, invoiceId);
    if (FINAL_STATUSES.includes(inv.status)) throw new InvalidStateError("Paid and written-off invoices cannot be edited.");
    await assertContacts(c, userId, inv.client_id, contacts);
    await rewriteInvoiceContacts(c, userId, invoiceId, contacts);
    await planInvoiceTx(c, userId, invoiceId, at);
    await logEvent(c, { userId, invoiceId, clientId: inv.client_id, type: "invoice_updated", detail: { changed: ["contacts"] }, at });
  });
}

// Validates one import row and writes it in its own transaction. Returns what happened.
async function importOne(userId: string, row: ImportInvoiceRow, clock: Clock): Promise<"created" | "duplicate" | "created_client"> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const at = clock.now();
    const clientName = cleanName(row.clientName, "Client name");
    const email = normalizeEmail(row.clientEmail, "Client email");
    const number = cleanInvoiceNumber(row.invoiceNumber);
    const amount = cleanAmountMinor(row.amountMinor);
    const currency = cleanCurrency(row.currency);
    const issueDate = cleanIsoDate(row.issueDate, "Issue date");
    const dueDate = cleanIsoDate(row.dueDate, "Due date");
    assertDueNotBeforeIssue(issueDate, dueDate);

    let client = await clientByEmail(c, userId, email);
    let clientCreated = false;
    if (!client) {
      const inserted = await c.query<{ id: string }>(
        "insert into clients (user_id, name, email, auto_send) values ($1, $2, $3, false) returning id",
        [userId, clientName, email],
      );
      const clientId = inserted.rows[0].id;
      await c.query(
        "insert into contacts (user_id, client_id, email, name, is_primary) values ($1, $2, $3, $4, true)",
        [userId, clientId, email, clientName],
      );
      client = { id: clientId };
      clientCreated = true;
    }
    // A row whose client and invoice number already exist is skipped, never overwritten.
    if (await duplicateNumber(c, userId, client.id, number, null)) return "duplicate";

    const primary = await clientPrimary(c, userId, client.id);
    const created = await c.query<{ id: string }>(
      `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'open', 'csv', $8) returning id`,
      [userId, client.id, number, amount, currency, issueDate, dueDate, at],
    );
    const invoiceId = created.rows[0].id;
    await c.query(
      "insert into invoice_contacts (user_id, invoice_id, contact_id, role) values ($1, $2, $3, 'primary')",
      [userId, invoiceId, primary.id],
    );
    await logEvent(c, { userId, invoiceId, clientId: client.id, type: "invoice_created", detail: { source: "csv" }, at });
    await planInvoiceTx(c, userId, invoiceId, at);
    return clientCreated ? "created_client" : "created";
  });
}

// The commit path for the CSV preview. Each row is atomic on its own, so a bad row
// is reported and the rest of the batch still imports. Re-running the same batch
// imports only what is missing, because duplicates are skipped.
export async function importInvoices(userId: string, rows: readonly ImportInvoiceRow[], clock: Clock): Promise<ImportResult> {
  const result: ImportResult = { created: 0, duplicates: 0, clientsCreated: 0, rejected: [] };
  for (const [index, row] of rows.entries()) {
    const line = row.line ?? index + 1;
    try {
      const outcome = await importOne(userId, row, clock);
      if (outcome === "duplicate") {
        result.duplicates += 1;
      } else {
        result.created += 1;
        if (outcome === "created_client") result.clientsCreated += 1;
      }
    } catch (err) {
      if (err instanceof EngineError) {
        result.rejected.push({ line, reason: err.message });
      } else {
        throw err;
      }
    }
  }
  return result;
}

// Plans every invoice that can still produce messages. Returns 0 and does nothing until
// onboarding is finished (spec 3.8). completeOnboarding calls this at the finish step.
export async function planOpenInvoices(userId: string, clock: Clock): Promise<number> {
  return withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const settings = await S.loadSettings(c, userId);
    if (!settings.onboarding_done) return 0;
    const at = clock.now();
    const { rows } = await c.query<{ id: string }>(
      "select id from invoices where user_id = $1 and status in ('open', 'payment_plan') order by id",
      [userId],
    );
    for (const row of rows) await planInvoiceTx(c, userId, row.id, at);
    return rows.length;
  });
}
