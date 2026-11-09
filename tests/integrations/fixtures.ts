// Seed rows for integration tests. Written through the admin connection (RLS bypassed),
// so each test controls exactly which rows exist.
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/lib/crypto";
import { adminQuery } from "../helpers/db";

export async function seedClientAndInvoice(
  userId: string,
  opts: { invoiceNumber?: string; amountMinor?: number; currency?: string; status?: string } = {},
): Promise<{ clientId: string; invoiceId: string }> {
  const { rows: clientRows } = await adminQuery<{ id: string }>(
    "insert into clients (user_id, name, email) values ($1, 'Acme Ltd', $2) returning id",
    [userId, `billing-${Math.random().toString(36).slice(2, 10)}@acme.example.test`],
  );
  const clientId = clientRows[0].id;
  const { rows: invoiceRows } = await adminQuery<{ id: string }>(
    `insert into invoices (user_id, client_id, invoice_number, amount_minor, currency, issue_date, due_date, status)
     values ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-31', $6) returning id`,
    [
      userId,
      clientId,
      opts.invoiceNumber ?? "INV-1001",
      opts.amountMinor ?? 100000,
      opts.currency ?? "USD",
      opts.status ?? "open",
    ],
  );
  return { clientId, invoiceId: invoiceRows[0].id };
}

export async function seedInstallment(
  userId: string,
  invoiceId: string,
  position: number,
  amountMinor: number,
  currency = "USD",
): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    `insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency)
     values ($1, $2, $3, '2026-11-30', $4, $5) returning id`,
    [userId, invoiceId, position, amountMinor, currency],
  );
  return rows[0].id;
}

// A Stripe connection as the connect flow leaves it: encrypted key, webhook token and
// per-endpoint signing secret. Returns the plaintext signing secret so tests can sign events.
export async function seedStripeConnection(
  userId: string,
  opts: { token?: string; signingSecret?: string } = {},
): Promise<{ token: string; signingSecret: string }> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const signingSecret = opts.signingSecret ?? `whsec_${randomBytes(16).toString("hex")}`;
  await adminQuery(
    `insert into connected_accounts
       (user_id, provider, secret_ciphertext, account_label,
        webhook_token, webhook_secret_ciphertext, stripe_webhook_endpoint_id)
     values ($1, 'stripe', $2, 'Restricted key ending 0000', $3, $4, 'we_test')`,
    [userId, encryptSecret("rk_test_dummy_not_a_real_key"), token, encryptSecret(signingSecret)],
  );
  return { token, signingSecret };
}

// Settings row with a complete sender profile by default. Overrides cover the digest cases.
export async function seedSettings(
  userId: string,
  opts: {
    timezone?: string;
    digestHour?: number;
    digestEnabled?: boolean;
    senderName?: string;
    businessName?: string;
    postalAddress?: string;
    sendingDomain?: string | null;
  } = {},
): Promise<void> {
  await adminQuery(
    `insert into settings
       (user_id, sender_name, business_name, postal_address, timezone, digest_hour, digest_enabled, sending_domain)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      opts.senderName ?? "Ada Books",
      opts.businessName ?? "Ada Books Ltd",
      opts.postalAddress ?? "1 Harbour Road\nBristol BS1 4XY",
      opts.timezone ?? "UTC",
      opts.digestHour ?? 8,
      opts.digestEnabled ?? true,
      opts.sendingDomain === undefined ? "invoices.example.test" : opts.sendingDomain,
    ],
  );
}

// A scheduled message for an invoice, planned at plannedAt. Goes through a real sequence
// step, because the schema requires one for sequence-driven rows.
export async function seedScheduledMessage(
  userId: string,
  invoiceId: string,
  clientId: string,
  plannedAt: Date,
  status = "scheduled",
): Promise<string> {
  const { rows: seqRows } = await adminQuery<{ id: string }>(
    "insert into sequences (user_id, name, kind) values ($1, 'Standard', 'standard') returning id",
    [userId],
  );
  const sequenceId = seqRows[0].id;
  const { rows: stepRows } = await adminQuery<{ id: string }>(
    `insert into sequence_steps (user_id, sequence_id, position, offset_days, tone, subject, body)
     values ($1, $2, 0, 0, 'friendly', 'Invoice {invoice_number} is due', 'Hello {client_name}') returning id`,
    [userId, sequenceId],
  );
  const stepId = stepRows[0].id;
  // Not primary: a client has at most one primary contact, and this helper may run several times.
  const { rows: contactRows } = await adminQuery<{ id: string }>(
    `insert into contacts (user_id, client_id, email, name, is_primary)
     values ($1, $2, $3, 'Accounts', false)
     returning id`,
    [userId, clientId, `ap-${Math.random().toString(36).slice(2, 10)}@acme.example.test`],
  );
  const contactId = contactRows[0].id;
  const { rows } = await adminQuery<{ id: string }>(
    `insert into scheduled_messages
       (user_id, invoice_id, step_id, contact_id, planned_at, status, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [userId, invoiceId, stepId, contactId, plannedAt, status, `${invoiceId}:${stepId}`],
  );
  return rows[0].id;
}

// An OAuth (Connect) connection as the callback leaves it: the account id in account_label,
// no stored token (secret_ciphertext is null), and no webhook endpoint.
export async function seedStripeOAuthConnection(
  userId: string,
  accountId = "acct_test123",
): Promise<void> {
  await adminQuery(
    `insert into connected_accounts (user_id, provider, secret_ciphertext, account_label)
     values ($1, 'stripe', null, $2)`,
    [userId, accountId],
  );
}
