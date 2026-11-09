// Account deletion (spec 3.8). Order matters:
//   1. Refuse unless the typed address matches the signed-in address exactly.
//   2. Disconnect Stripe: deletes the stored key and tries to delete the webhook endpoint.
//   3. Delete the user row through withUser, so row-level security applies. Foreign keys cascade
//      to every tenant table, including settings, invoices, messages, events and connections.
//   4. Delete the user's sessions and login links through withService. Both are filtered explicitly.
// After step 3, a Stripe webhook for this account finds no connection row and does nothing.
import { withService, withUser } from "@/lib/db";
import { lockUser } from "@/lib/engine";
import { disconnectStripe, type StripeConnectionDeps } from "@/lib/providers/stripe-connection";

export class AccountDeletionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountDeletionRefusedError";
  }
}

export interface DeleteAccountDeps {
  stripe?: StripeConnectionDeps;
}

export interface DeleteAccountResult {
  // null when there was no Stripe connection to delete.
  stripeEndpointDeleted: boolean | null;
}

// Exact comparison. Only surrounding whitespace is ignored, so the user has to type the
// address as shown. The stored address is lower-case, so the match is case-sensitive too.
export function emailConfirmationMatches(typed: unknown, email: string): boolean {
  return typeof typed === "string" && email !== "" && typed.trim() === email;
}

export async function deleteAccount(
  userId: string,
  typedEmail: unknown,
  deps: DeleteAccountDeps = {},
): Promise<DeleteAccountResult> {
  const email = await accountEmail(userId);
  if (email === null) {
    throw new AccountDeletionRefusedError("This account could not be found. Sign in again and retry.");
  }
  if (!emailConfirmationMatches(typedEmail, email)) {
    throw new AccountDeletionRefusedError(
      "The address you typed does not match your sign-in address. Type it exactly as shown.",
    );
  }

  const stripe = await disconnectStripe(userId, deps.stripe);

  await withUser(userId, async (c) => {
    // The engine's per-user lock, so a sender run for this user cannot interleave with the delete.
    await lockUser(c, userId);
    const { rowCount } = await c.query("delete from users where id = $1", [userId]);
    if (rowCount !== 1) throw new Error("account row was not deleted");
  });

  await withService(async (c) => {
    await c.query("delete from sessions where user_id = $1", [userId]);
    // Login links are keyed by address, not by user id, so they are removed by address.
    await c.query("delete from login_tokens where email = $1", [email]);
  });

  return { stripeEndpointDeleted: stripe.removed ? stripe.endpointDeleted : null };
}

async function accountEmail(userId: string): Promise<string | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ email: string }>("select email from users where id = $1", [userId]);
    return rows[0]?.email ?? null;
  });
}
