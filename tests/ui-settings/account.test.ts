// Account deletion against the real database, with the Stripe client injected as a fake.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { AccountDeletionRefusedError, deleteAccount } from "@/lib/account";
import { addInvoice, connectionCount, fakeStripe, seedStripeConnection, sessionTokenFor, setupOwner } from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function countRows(table: string, userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>(`select count(*)::text as n from ${table} where user_id = $1`, [userId]);
  return Number(rows[0].n);
}

async function userExists(userId: string): Promise<boolean> {
  const { rows } = await adminQuery("select 1 from users where id = $1", [userId]);
  return rows.length > 0;
}

async function loginLinksFor(email: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from login_tokens where email = $1", [email]);
  return Number(rows[0].n);
}

describe("refusals happen before anything is removed or sent to Stripe", () => {
  it.each([
    ["an empty confirmation", (_email: string) => ""],
    ["the address in capitals", (email: string) => email.toUpperCase()],
    ["the address with a trailing character", (email: string) => `${email}.`],
    ["a missing confirmation", (_email: string) => undefined],
    ["a non-string confirmation", (_email: string) => 42],
  ])("refuses %s", async (_name, typedFor) => {
    const owner = await setupOwner();
    await addInvoice(owner.userId);
    await seedStripeConnection(owner.userId);
    const stripe = fakeStripe();

    await expect(deleteAccount(owner.userId, typedFor(owner.email), { stripe: stripe.deps })).rejects.toBeInstanceOf(
      AccountDeletionRefusedError,
    );

    expect(await userExists(owner.userId)).toBe(true);
    expect(await countRows("invoices", owner.userId)).toBe(1);
    expect(await connectionCount(owner.userId)).toBe(1);
    expect(stripe.deleted).toHaveLength(0);
    expect(stripe.listCalls).toBe(0);
  });

  it("refuses another user's address, and leaves both accounts alone", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    await expect(deleteAccount(alice.userId, bob.email)).rejects.toBeInstanceOf(AccountDeletionRefusedError);
    expect(await userExists(alice.userId)).toBe(true);
    expect(await userExists(bob.userId)).toBe(true);
  });

  it("refuses a confirmation that differs only by surrounding text", async () => {
    const owner = await setupOwner();
    await expect(deleteAccount(owner.userId, `${owner.email}x`)).rejects.toBeInstanceOf(AccountDeletionRefusedError);
    expect(await userExists(owner.userId)).toBe(true);
  });

  it("refuses for an account that no longer exists", async () => {
    const owner = await setupOwner();
    await adminQuery("delete from users where id = $1", [owner.userId]);
    await expect(deleteAccount(owner.userId, owner.email)).rejects.toThrow(/could not be found/);
  });
});

describe("success removes every row the user owns", () => {
  it("deletes the account, its data, sessions and login links, and the Stripe key and endpoint", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    const invoice = await addInvoice(alice.userId, { invoiceNumber: "ALICE-1" });
    await addInvoice(bob.userId, { invoiceNumber: "BOB-1" });
    await adminQuery(
      "insert into events (user_id, invoice_id, type, detail) values ($1, $2, 'invoice_created', '{}'::jsonb)",
      [alice.userId, invoice.invoiceId],
    );
    await seedStripeConnection(alice.userId);
    await sessionTokenFor(alice.userId);
    await adminQuery("insert into login_tokens (email, token_hash, expires_at) values ($1, 'hash-alice', now() + interval '1 hour')", [alice.email]);
    const stripe = fakeStripe();

    const result = await deleteAccount(alice.userId, alice.email, { stripe: stripe.deps });

    expect(result).toEqual({ stripeEndpointDeleted: true });
    expect(stripe.deleted).toEqual(["we_seeded"]);
    expect(await userExists(alice.userId)).toBe(false);
    for (const table of ["settings", "clients", "contacts", "invoices", "sequences", "sequence_steps", "scheduled_messages", "events", "connected_accounts", "digests"]) {
      expect(await countRows(table, alice.userId)).toBe(0);
    }
    const { rows: sessions } = await adminQuery("select 1 from sessions where user_id = $1", [alice.userId]);
    expect(sessions).toHaveLength(0);
    expect(await loginLinksFor(alice.email)).toBe(0);

    // The other account is untouched.
    expect(await userExists(bob.userId)).toBe(true);
    expect(await countRows("invoices", bob.userId)).toBe(1);
    expect(await countRows("settings", bob.userId)).toBe(1);
  });

  it("still deletes everything when Stripe refuses the endpoint delete, and says so", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId);
    const stripe = fakeStripe({ endpointDeleteFails: true });

    const result = await deleteAccount(owner.userId, owner.email, { stripe: stripe.deps });

    expect(result).toEqual({ stripeEndpointDeleted: false });
    expect(await userExists(owner.userId)).toBe(false);
    expect(await connectionCount(owner.userId)).toBe(0);
  });

  it("reports null for the endpoint when there was no Stripe connection, and makes no Stripe call", async () => {
    const owner = await setupOwner();
    const stripe = fakeStripe();
    expect(await deleteAccount(owner.userId, owner.email, { stripe: stripe.deps })).toEqual({ stripeEndpointDeleted: null });
    expect(stripe.deleted).toHaveLength(0);
    expect(await userExists(owner.userId)).toBe(false);
  });

  it("leaves no connection row for a later Stripe webhook to match", async () => {
    const owner = await setupOwner();
    const token = await seedStripeConnection(owner.userId);
    await deleteAccount(owner.userId, owner.email, { stripe: fakeStripe().deps });
    const { rows } = await adminQuery("select 1 from connected_accounts where webhook_token = $1", [token]);
    expect(rows).toHaveLength(0);
  });
});
