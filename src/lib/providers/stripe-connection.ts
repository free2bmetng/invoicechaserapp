// Per-user Stripe connection, in two modes.
//
// OAuth (default; Stripe Connect Standard). connectStripeOAuth stores the connected account id
// in connected_accounts.account_label and the access token encrypted in secret_ciphertext.
// Payments run on the platform key with stripeAccount, and disconnect calls deauthorize.
//
// Restricted key (STRIPE_KEY_MODE=restricted only, internal testing). connectStripe validates a
// restricted key, creates a per-connection webhook endpoint, and stores the key and that
// endpoint's signing secret. The key needs read and write on Webhook Endpoints, plus Payment
// Links and Prices. Without webhook write access, connectStripe fails and stores nothing.
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { withService, withUser } from "@/lib/db";
import {
  deauthorizeAccount,
  exchangeOAuthCode,
  isStripeAccountId,
  StripeOAuthError,
} from "./stripe-oauth";
import { platformStripeClient, restrictedKeyMode, type StripePlatformClient } from "./stripe-platform";

export const STRIPE_WEBHOOK_EVENTS = ["checkout.session.completed"] as const;
const STRIPE_TIMEOUT_MS = 10_000;

export class StripeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConnectionError";
  }
}

// Restricted-key path: the subset of the Stripe client it uses. Tests inject a fake.
export interface StripeConnectionClient {
  webhookEndpoints: {
    list(params: Stripe.WebhookEndpointListParams): Promise<unknown>;
    create(params: Stripe.WebhookEndpointCreateParams): Promise<{ id: string; secret?: string }>;
    del(id: string): Promise<unknown>;
  };
}

export interface StripeConnectionDeps {
  // Restricted-key path.
  createClient?: (apiKey: string) => StripeConnectionClient;
  // Overridable so tests can force a token collision.
  newToken?: () => string;
  // OAuth path.
  platformClient?: () => StripePlatformClient;
  // Test hook: runs after the duplicate check and before the insert, so a test can make another
  // user take the account in between and exercise the unique index.
  afterAccountCheck?: () => Promise<void>;
}

function defaultClient(apiKey: string): StripeConnectionClient {
  return new Stripe(apiKey, { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 1 }) as unknown as StripeConnectionClient;
}

function defaultToken(): string {
  return randomBytes(24).toString("base64url");
}

export function stripeWebhookUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/stripe/${token}`;
}

type Previous = {
  // Set for an OAuth connection.
  accountId: string | null;
  // Set for a restricted-key connection that has an endpoint to remove.
  apiKey: string | null;
  endpointId: string | null;
};

// Stores an OAuth connection after a successful code exchange. Stripe account ids are unique
// across Invoice Chaser accounts, so an account already held by another user is refused.
export async function connectStripeOAuth(
  userId: string,
  code: string,
  deps: StripeConnectionDeps = {},
): Promise<{ stripeAccountId: string }> {
  if (!process.env.STRIPE_CONNECT_CLIENT_ID) {
    throw new StripeOAuthError("config", "STRIPE_CONNECT_CLIENT_ID is not set.");
  }
  const platform = platformFor(deps);
  const account = await exchangeOAuthCode(platform, code);

  // Fast path for the common case. The unique index below is the real guard against a race.
  if (await accountHeldByAnotherUser(account.stripeAccountId, userId)) throw alreadyConnected();
  if (deps.afterAccountCheck) await deps.afterAccountCheck();

  const previous = await readConnection(userId);
  try {
    await withUser(userId, (c) =>
      c.query(
        `insert into connected_accounts
           (user_id, provider, secret_ciphertext, account_label, webhook_token, webhook_secret_ciphertext, stripe_webhook_endpoint_id)
         values ($1, 'stripe', null, $2, null, null, null)
         on conflict (user_id, provider) do update set
           secret_ciphertext = null,
           account_label = excluded.account_label,
           webhook_token = null,
           webhook_secret_ciphertext = null,
           stripe_webhook_endpoint_id = null`,
        [userId, account.stripeAccountId],
      ),
    );
  } catch (err) {
    if (isAccountIndexViolation(err)) throw alreadyConnected();
    throw err;
  }
  await retirePrevious(previous, account.stripeAccountId, deps);
  return { stripeAccountId: account.stripeAccountId };
}

// Restricted-key connection. Refused unless STRIPE_KEY_MODE=restricted.
export async function connectStripe(
  userId: string,
  restrictedKey: string,
  appUrl: string,
  deps: StripeConnectionDeps = {},
): Promise<{ endpointId: string }> {
  if (!restrictedKeyMode()) {
    throw new StripeConnectionError(
      "Connecting with a restricted key is turned off. Connect Stripe with the Stripe button instead.",
    );
  }
  const key = restrictedKey.trim();
  if (!key.startsWith("rk_")) {
    throw new StripeConnectionError("Paste a restricted key. Its name starts with rk_. Secret keys are not accepted.");
  }
  const client = (deps.createClient ?? defaultClient)(key);

  try {
    await client.webhookEndpoints.list({ limit: 1 });
  } catch {
    throw new StripeConnectionError(
      "Stripe rejected this key, or it cannot read and write webhook endpoints. Check the key's permissions.",
    );
  }

  const token = (deps.newToken ?? defaultToken)();
  const endpoint = await client.webhookEndpoints.create({
    url: stripeWebhookUrl(appUrl, token),
    enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    description: "Invoice Chaser payments",
  });
  if (!endpoint.secret) {
    await bestEffortDelete(client, endpoint.id);
    throw new StripeConnectionError("Stripe did not return a signing secret for the webhook endpoint.");
  }

  const previous = await readConnection(userId);
  try {
    await withUser(userId, (c) =>
      c.query(
        `insert into connected_accounts
           (user_id, provider, secret_ciphertext, account_label, webhook_token, webhook_secret_ciphertext, stripe_webhook_endpoint_id)
         values ($1, 'stripe', $2, $3, $4, $5, $6)
         on conflict (user_id, provider) do update set
           secret_ciphertext = excluded.secret_ciphertext,
           account_label = excluded.account_label,
           webhook_token = excluded.webhook_token,
           webhook_secret_ciphertext = excluded.webhook_secret_ciphertext,
           stripe_webhook_endpoint_id = excluded.stripe_webhook_endpoint_id`,
        [
          userId,
          encryptSecret(key),
          `Restricted key ending ${key.slice(-4)}`,
          token,
          encryptSecret(endpoint.secret as string),
          endpoint.id,
        ],
      ),
    );
  } catch (err) {
    // Storing failed (for example a token collision), so do not leave an orphan endpoint.
    await bestEffortDelete(client, endpoint.id);
    throw err;
  }

  await retirePrevious(previous, null, deps);
  return { endpointId: endpoint.id };
}

// Removes the stored key or account link. For an OAuth connection it calls deauthorize. For a
// restricted-key connection it deletes the webhook endpoint. The row is removed even if Stripe
// refuses, so the app stops holding the credential. The flags report what Stripe did:
//   deauthorized   the OAuth account was revoked (false when there was no OAuth account)
//   endpointDeleted  no Invoice Chaser webhook endpoint remains
export async function disconnectStripe(
  userId: string,
  deps: StripeConnectionDeps = {},
): Promise<{ removed: boolean; endpointDeleted: boolean; deauthorized: boolean }> {
  const existing = await readConnection(userId);
  if (!existing) return { removed: false, endpointDeleted: false, deauthorized: false };

  const deauthorized = existing.accountId ? await deauthorizeOwnAccount(existing.accountId, deps) : false;
  let endpointDeleted = true;
  if (existing.endpointId) {
    endpointDeleted = await deleteEndpointWith(existing.apiKey, existing.endpointId, deps);
  }
  await withUser(userId, (c) =>
    c.query("delete from connected_accounts where user_id = $1 and provider = 'stripe'", [userId]),
  );
  return { removed: true, endpointDeleted, deauthorized };
}

function alreadyConnected(): StripeOAuthError {
  return new StripeOAuthError(
    "already_connected",
    "This Stripe account is already connected to another Invoice Chaser account.",
  );
}

// Postgres 23505 on the partial unique index for OAuth account ids (migration 0005).
function isAccountIndexViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && e?.constraint === "connected_accounts_stripe_account_unique";
}

function platformFor(deps: StripeConnectionDeps): StripePlatformClient {
  try {
    return (deps.platformClient ?? platformStripeClient)();
  } catch {
    throw new StripeOAuthError("config", "The Stripe platform key is not configured.");
  }
}

async function accountHeldByAnotherUser(accountId: string, userId: string): Promise<boolean> {
  const { rowCount } = await withService((c) =>
    c.query(
      "select 1 from connected_accounts where provider = 'stripe' and account_label = $1 and user_id <> $2",
      [accountId, userId],
    ),
  );
  return (rowCount ?? 0) > 0;
}

async function readConnection(userId: string): Promise<Previous | null> {
  const { rows } = await withUser(userId, (c) =>
    c.query<{ secret_ciphertext: string | null; account_label: string; stripe_webhook_endpoint_id: string | null }>(
      `select secret_ciphertext, account_label, stripe_webhook_endpoint_id
         from connected_accounts where user_id = $1 and provider = 'stripe'`,
      [userId],
    ),
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const accountId = isStripeAccountId(row.account_label) ? row.account_label : null;
  let apiKey: string | null = null;
  if (row.stripe_webhook_endpoint_id && row.secret_ciphertext) {
    try {
      apiKey = decryptSecret(row.secret_ciphertext);
    } catch {
      apiKey = null;
    }
  }
  return { accountId, apiKey, endpointId: row.stripe_webhook_endpoint_id };
}

// After a replacement, retires the previous connection's Stripe-side resources. Best effort:
// the new connection is already stored.
async function retirePrevious(previous: Previous | null, keepAccountId: string | null, deps: StripeConnectionDeps) {
  if (!previous) return;
  if (previous.accountId && previous.accountId !== keepAccountId) {
    await deauthorizeOwnAccount(previous.accountId, deps);
  }
  if (previous.endpointId) {
    await deleteEndpointWith(previous.apiKey, previous.endpointId, deps);
  }
}

async function deauthorizeOwnAccount(accountId: string, deps: StripeConnectionDeps): Promise<boolean> {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return false;
  let platform: StripePlatformClient;
  try {
    platform = (deps.platformClient ?? platformStripeClient)();
  } catch {
    return false;
  }
  return deauthorizeAccount(platform, clientId, accountId);
}

async function deleteEndpointWith(
  apiKey: string | null,
  endpointId: string,
  deps: StripeConnectionDeps,
): Promise<boolean> {
  if (!apiKey) return false;
  const client = (deps.createClient ?? defaultClient)(apiKey);
  try {
    await client.webhookEndpoints.del(endpointId);
    return true;
  } catch {
    return false;
  }
}

async function bestEffortDelete(client: StripeConnectionClient, endpointId: string): Promise<void> {
  try {
    await client.webhookEndpoints.del(endpointId);
  } catch {
    // Nothing more to do here. The caller reports the original error.
  }
}
