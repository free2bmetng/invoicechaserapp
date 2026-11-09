// Fixtures for the UI-ops tests. Accounts, clients and invoices are created through the
// engine, so the rows match what the app writes. Setup reads and the few status
// overrides go through the superuser (adminQuery), which bypasses RLS, as in tests/engine.
import { fixedClock } from "@/lib/clock";
import { createClient, createInvoice, provisionUser, runSender } from "@/lib/engine";
import { FakeEmailProvider } from "@/lib/providers/fake";
import { ProviderAmbiguousError, ProviderRefusedError, type OutgoingEmail, type SendResult } from "@/lib/providers/types";
import { adminQuery, createUser, resetDb } from "../helpers/db";

// Invoices are created on PLAN_ISO. Their steps land on 2030-01-10 at 09:00 UTC, and the
// sender runs at SEND_ISO, inside the 09:00-17:00 window. Real time is 2026, so rows in
// 2030 always count as "in the future" for resume and hold checks.
export const PLAN_ISO = "2030-01-09T08:00:00.000Z";
export const SEND_ISO = "2030-01-10T10:00:00.000Z";
export const NEXT7_ISO = "2030-01-09T12:00:00.000Z";

export { resetDb };

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export async function newUser(
  opts: { timezone?: string; onboarding?: boolean; profile?: boolean; dailyCap?: number } = {},
): Promise<string> {
  const userId = await createUser(`${uniq("owner")}@example.test`);
  await provisionUser(userId, fixedClock(PLAN_ISO));
  const profile = opts.profile === false ? ["", "", ""] : ["Maya Okafor", "Okafor Studio", "14 Canal Street, Manchester"];
  await adminQuery(
    `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5,
       onboarding_done = $6, daily_cap = $7, sending_domain = 'mail.example.test' where user_id = $1`,
    [userId, profile[0], profile[1], profile[2], opts.timezone ?? "UTC", opts.onboarding ?? true, opts.dailyCap ?? 20],
  );
  return userId;
}

export interface ClientFixture {
  clientId: string;
  contactId: string;
  email: string;
}

export async function newClient(
  userId: string,
  opts: { name?: string; autoSend?: boolean; timezone?: string | null } = {},
): Promise<ClientFixture> {
  const email = `${uniq("client")}@example.test`;
  const created = await createClient(
    userId,
    { name: opts.name ?? "Acme Ltd", email, autoSend: opts.autoSend ?? false, timezone: opts.timezone ?? null },
    fixedClock(PLAN_ISO),
  );
  return { clientId: created.clientId, contactId: created.contactId, email };
}

export async function newInvoice(
  userId: string,
  clientId: string,
  opts: {
    number?: string;
    amountMinor?: number;
    currency?: string;
    issue?: string;
    due?: string;
    contacts?: { primaryContactId: string; ccContactIds: string[] };
    clock?: string;
  } = {},
): Promise<string> {
  const created = await createInvoice(
    userId,
    {
      clientId,
      invoiceNumber: opts.number ?? uniq("INV-"),
      amountMinor: opts.amountMinor ?? 10000,
      currency: opts.currency ?? "USD",
      issueDate: opts.issue ?? "2029-12-01",
      dueDate: opts.due ?? "2030-01-10",
      contacts: opts.contacts,
    },
    fixedClock(opts.clock ?? PLAN_ISO),
  );
  return created.invoiceId;
}

// The first reminder on an invoice at a given step offset with a given status.
export async function messageFor(invoiceId: string, offset = 0, status?: string): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    `select m.id from scheduled_messages m left join sequence_steps st on st.id = m.step_id
      where m.invoice_id = $1 and st.offset_days = $2 ${status ? "and m.status = $3" : ""}
      order by m.planned_at limit 1`,
    status ? [invoiceId, offset, status] : [invoiceId, offset],
  );
  if (!rows[0]) throw new Error(`no message at offset ${offset} for invoice ${invoiceId}`);
  return rows[0].id;
}

export async function statusOf(messageId: string): Promise<string> {
  const { rows } = await adminQuery<{ status: string }>("select status from scheduled_messages where id = $1", [messageId]);
  return rows[0].status;
}

export async function setRowStatus(messageId: string, status: string): Promise<void> {
  await adminQuery("update scheduled_messages set status = $2 where id = $1", [messageId, status]);
}

// Email double with per-recipient outcomes: refusals and timeouts are real provider
// errors, so the sender's own state machine produces failed and needs_check rows.
export class ScriptedEmail extends FakeEmailProvider {
  constructor(
    private readonly refuse: ReadonlySet<string> = new Set(),
    private readonly ambiguous: ReadonlySet<string> = new Set(),
  ) {
    super();
  }

  override async send(email: OutgoingEmail): Promise<SendResult> {
    const to = email.to.toLowerCase();
    if (this.refuse.has(to)) {
      this.calls.push(email);
      throw new ProviderRefusedError("scripted refusal");
    }
    if (this.ambiguous.has(to)) {
      this.calls.push(email);
      throw new ProviderAmbiguousError("scripted timeout");
    }
    return super.send(email);
  }
}

// Runs the sender at SEND_ISO with the given email double. Payments are off.
export async function runSendWindow(email: FakeEmailProvider = new FakeEmailProvider()) {
  const result = await runSender(
    {
      clock: fixedClock(SEND_ISO),
      appUrl: "http://localhost:3000",
      emailFor: async () => email,
      paymentsFor: async () => null,
    },
    { batchSize: 200 },
  );
  return { email, result };
}
