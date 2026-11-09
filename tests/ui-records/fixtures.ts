// Shared fixtures for the records UI tests. Setup goes through the engine's public API, and reads
// and fixture-only changes go through the superuser helper. Nothing here calls email or Stripe.
import { adminQuery, createUser } from "../helpers/db";
import { fixedClock } from "@/lib/clock";
import { createClient, createInvoice, provisionUser, setInvoiceStatus } from "@/lib/engine";
import type { InvoiceStatus } from "@/lib/types";

export { adminQuery, resetDb } from "../helpers/db";

export const NOW = "2026-11-10T12:00:00.000Z";
export const clock = fixedClock(NOW);

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export interface TestUser {
  userId: string;
  email: string;
}

// A user with a complete sender profile, onboarding finished and the default sequences seeded.
export async function makeUser(opts: { profile?: boolean; timezone?: string; stripe?: boolean } = {}): Promise<TestUser> {
  const email = `${uniq("owner")}@example.test`;
  const userId = await createUser(email);
  await provisionUser(userId, clock);
  const profile = opts.profile === false ? ["", "", ""] : ["Ada Lovelace", "Ada Studio", "1 Main St, Springfield"];
  await adminQuery(
    `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5, onboarding_done = true
     where user_id = $1`,
    [userId, profile[0], profile[1], profile[2], opts.timezone ?? "UTC"],
  );
  if (opts.stripe) {
    await adminQuery(
      "insert into connected_accounts (user_id, provider, secret_ciphertext, account_label) values ($1, 'stripe', 'test-ciphertext', 'acct_test')",
      [userId],
    );
  }
  return { userId, email };
}

export interface ClientFixture {
  clientId: string;
  contactId: string;
  email: string;
}

export async function makeClient(
  userId: string,
  opts: { name?: string; email?: string; timezone?: string | null } = {},
): Promise<ClientFixture> {
  const email = (opts.email ?? `${uniq("client")}@example.test`).toLowerCase();
  const created = await createClient(
    userId,
    { name: opts.name ?? "Acme Ltd", email, timezone: opts.timezone ?? null, sequenceId: null, autoSend: false },
    clock,
  );
  return { clientId: created.clientId, contactId: created.contactId, email };
}

export interface InvoiceFixture {
  invoiceId: string;
  number: string;
}

// Creates through the engine, so the reminder rows are planned the way production plans them.
export async function makeInvoice(
  userId: string,
  clientId: string,
  opts: { number?: string; amountMinor?: number; currency?: string; issue?: string; due?: string; status?: InvoiceStatus } = {},
): Promise<InvoiceFixture> {
  const number = opts.number ?? uniq("INV-");
  const created = await createInvoice(
    userId,
    {
      clientId,
      invoiceNumber: number,
      amountMinor: opts.amountMinor ?? 125000,
      currency: opts.currency ?? "USD",
      issueDate: opts.issue ?? "2026-10-01",
      dueDate: opts.due ?? "2027-06-15",
    },
    clock,
  );
  if (opts.status && opts.status !== "open") {
    await setInvoiceStatus(userId, created.invoiceId, opts.status, clock);
  }
  return { invoiceId: created.invoiceId, number };
}

// Builds FormData the way a browser form would: repeated names become repeated entries.
export function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

export async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await adminQuery<Record<string, unknown>>(sql, params);
  const row = rows[0] ?? {};
  return Object.values(row)[0] as T;
}

export async function unsentCount(invoiceId: string): Promise<number> {
  return Number(await scalar("select count(*)::text from scheduled_messages where invoice_id = $1 and status in ('pending_approval','scheduled','held')", [invoiceId]));
}

export async function statusCount(invoiceId: string, status: string): Promise<number> {
  return Number(await scalar("select count(*)::text from scheduled_messages where invoice_id = $1 and status = $2", [invoiceId, status]));
}
