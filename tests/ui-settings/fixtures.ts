// Fixtures for the settings and onboarding tests. Setup goes through the superuser connection
// (RLS bypassed), so each test controls exactly which rows exist. Code under test runs through its
// real public functions. The Stripe client is a fake injected through the existing deps parameter,
// so nothing reaches the network.
import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { hashToken } from "@/lib/auth";
import { fixedClock, type Clock } from "@/lib/clock";
import { encryptSecret } from "@/lib/crypto";
import { provisionUser } from "@/lib/engine";
import type { StripeConnectionClient, StripeConnectionDeps } from "@/lib/providers/stripe-connection";
import { adminQuery, createUser } from "../helpers/db";

// Tuesday 2026-11-03 10:00 UTC. Every invoice below is due later, so planning keeps every step.
export const NOW = "2026-11-03T10:00:00.000Z";

export function clockAt(iso: string = NOW): Clock & { set(iso: string): void } {
  return fixedClock(iso);
}

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export interface Owner {
  userId: string;
  email: string;
}

// Creates a user with the default sequences (as sign-in does) and a settings row.
// profile:false clears the sender details. domain:null leaves sending unset.
export async function setupOwner(
  opts: {
    profile?: boolean;
    domain?: string | null;
    timezone?: string;
    dailyCap?: number;
    onboardingDone?: boolean;
    reviewed?: boolean;
  } = {},
): Promise<Owner> {
  const email = `${uniq("owner")}@example.test`;
  const userId = await createUser(email);
  await provisionUser(userId, clockAt());
  const profile = opts.profile === false ? ["", "", ""] : ["Ada Lovelace", "Ada Studio Ltd", "1 Harbour Road\nBristol BS1 4XY"];
  const domain = opts.domain === undefined ? "invoices.example.test" : opts.domain;
  await adminQuery(
    `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5,
            sending_domain = $6, daily_cap = $7, onboarding_done = $8
      where user_id = $1`,
    [
      userId,
      profile[0],
      profile[1],
      profile[2],
      opts.timezone ?? "UTC",
      domain,
      opts.dailyCap ?? 20,
      opts.onboardingDone ?? false,
    ],
  );
  if (opts.reviewed) {
    await adminQuery(
      "insert into events (user_id, type, detail) values ($1, 'onboarding_sequence_reviewed', '{}'::jsonb)",
      [userId],
    );
  }
  return { userId, email };
}

export interface InvoiceFixture {
  clientId: string;
  contactId: string;
  invoiceId: string;
}

// A client with one primary contact and one invoice. Due dates default to late November 2026.
export async function addInvoice(
  userId: string,
  opts: {
    status?: string;
    amountMinor?: number;
    currency?: string;
    dueDate?: string;
    invoiceNumber?: string;
    clientEmail?: string;
  } = {},
): Promise<InvoiceFixture> {
  const email = (opts.clientEmail ?? `${uniq("client")}@example.test`).toLowerCase();
  const { rows: clientRows } = await adminQuery<{ id: string }>(
    "insert into clients (user_id, name, email) values ($1, 'Acme Ltd', $2) returning id",
    [userId, email],
  );
  const clientId = clientRows[0].id;
  const { rows: contactRows } = await adminQuery<{ id: string }>(
    `insert into contacts (user_id, client_id, email, name, is_primary)
     values ($1, $2, $3, 'Accounts', true) returning id`,
    [userId, clientId, email],
  );
  const contactId = contactRows[0].id;
  const { rows: invoiceRows } = await adminQuery<{ id: string }>(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status)
     values ($1, $2, $3, $4, $5, '2026-10-20', $6, $7) returning id`,
    [
      userId,
      clientId,
      opts.invoiceNumber ?? uniq("INV-"),
      opts.amountMinor ?? 120000,
      opts.currency ?? "USD",
      opts.dueDate ?? "2026-11-30",
      opts.status ?? "open",
    ],
  );
  return { clientId, contactId, invoiceId: invoiceRows[0].id };
}

// Writes an installment plan on an invoice and sets the invoice to payment_plan.
export async function addPlan(
  userId: string,
  invoiceId: string,
  installments: Array<{ due: string; amountMinor: number }>,
): Promise<string[]> {
  await adminQuery("update invoices set status = 'payment_plan' where id = $1", [invoiceId]);
  const ids: string[] = [];
  for (const [index, item] of installments.entries()) {
    const { rows } = await adminQuery<{ id: string }>(
      `insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency)
       values ($1, $2, $3, $4, $5, 'USD') returning id`,
      [userId, invoiceId, index + 1, item.due, item.amountMinor],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

// A server-side session for the user. Returns the raw token the browser would hold.
export async function sessionTokenFor(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adminQuery(
    "insert into sessions (id_hash, user_id, expires_at, created_at) values ($1, $2, now() + interval '1 day', now())",
    [hashToken(token), userId],
  );
  return token;
}

// Stores a Stripe connection the way connectStripe leaves it, without calling Stripe.
export async function seedStripeConnection(userId: string, key = "rk_live_SECRETVALUE_0042"): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await adminQuery(
    `insert into connected_accounts
       (user_id, provider, secret_ciphertext, account_label, webhook_token, webhook_secret_ciphertext, stripe_webhook_endpoint_id)
     values ($1, 'stripe', $2, $3, $4, $5, 'we_seeded')`,
    [userId, encryptSecret(key), `Restricted key ending ${key.slice(-4)}`, token, encryptSecret("whsec_seeded")],
  );
  return token;
}

export interface FakeStripe {
  deps: StripeConnectionDeps;
  created: Stripe.WebhookEndpointCreateParams[];
  deleted: string[];
  listCalls: number;
  keysUsed: string[];
}

// A fake of the Stripe webhook endpoint calls. endpointDeleteFails simulates a restricted key that
// may not delete endpoints, so disconnect must report endpointDeleted:false.
export function fakeStripe(opts: { endpointDeleteFails?: boolean; createFails?: boolean } = {}): FakeStripe {
  const created: Stripe.WebhookEndpointCreateParams[] = [];
  const deleted: string[] = [];
  const keysUsed: string[] = [];
  const state = { listCalls: 0 };
  let seq = 0;

  const client = (apiKey: string): StripeConnectionClient => {
    keysUsed.push(apiKey);
    return {
      webhookEndpoints: {
        async list() {
          state.listCalls += 1;
          return { data: [] };
        },
        async create(params: Stripe.WebhookEndpointCreateParams) {
          created.push(params);
          if (opts.createFails) throw new Error("restricted key lacks webhook write permission");
          seq += 1;
          return { id: `we_fake_${seq}`, secret: `whsec_fake_${seq}` };
        },
        async del(id: string) {
          deleted.push(id);
          if (opts.endpointDeleteFails) throw new Error("permission denied");
          return { id, deleted: true };
        },
      },
    };
  };

  return {
    deps: { createClient: client },
    created,
    deleted,
    get listCalls() {
      return state.listCalls;
    },
    keysUsed,
  };
}

export async function connectionCount(userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>(
    "select count(*)::text as n from connected_accounts where user_id = $1",
    [userId],
  );
  return Number(rows[0].n);
}

export async function plannedRowCount(userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>(
    "select count(*)::text as n from scheduled_messages where user_id = $1",
    [userId],
  );
  return Number(rows[0].n);
}
