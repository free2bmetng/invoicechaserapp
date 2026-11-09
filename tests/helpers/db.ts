// Shared test DB helpers. Each test file resets the database; tests never share rows.
import { Client } from "pg";
import { TEST_ENV } from "./env";

export async function adminQuery<T = unknown>(sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: TEST_ENV.DATABASE_ADMIN_URL });
  await c.connect();
  try {
    return await c.query<T & Record<string, unknown>>(sql, params);
  } finally {
    await c.end();
  }
}

export async function resetDb(): Promise<void> {
  await adminQuery(`
    truncate table message_log, scheduled_messages, invoice_contacts, payment_plan_installments,
      invoices, sequence_steps, sequences, contacts, clients, settings, events,
      connected_accounts, stripe_events, digests, login_tokens, sessions, users
    restart identity cascade`);
}

export async function createUser(email = "owner@example.test"): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "insert into users (email) values ($1) returning id", [email]);
  return rows[0].id;
}
