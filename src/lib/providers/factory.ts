// Chooses the email and payment adapters. Email is platform-level in v1: one Resend
// account (RESEND_API_KEY) sends for every user. Payments are per user: each user's
// own restricted Stripe key, stored encrypted in connected_accounts.
import Stripe from "stripe";
import { decryptSecret } from "@/lib/crypto";
import { withService } from "@/lib/db";
import { FakeEmailProvider } from "./fake";
import { ResendEmailProvider } from "./resend";
import { StripePaymentProvider } from "./stripe";
import { isStripeAccountId } from "./stripe-oauth";
import { platformStripeClient, restrictedKeyMode } from "./stripe-platform";
import type { EmailProvider, PaymentProvider } from "./types";

const STRIPE_TIMEOUT_MS = 10_000;

let sharedFake: FakeEmailProvider | undefined;

// The one fake the app uses while sending is off. Tests inspect it through this export.
export function getFakeEmail(): FakeEmailProvider {
  sharedFake ??= new FakeEmailProvider();
  return sharedFake;
}

function sendingEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

// Fails loudly when sending is on but the key is missing. It never falls back to the
// fake, because that would mark messages as sent when nothing left the building.
function platformEmail(): EmailProvider {
  if (!sendingEnabled()) return getFakeEmail();
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set, but SEND_ENABLED=true");
  return new ResendEmailProvider({ apiKey });
}

// Client-facing email. The userId is part of the contract; v1 uses one platform sender.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- contract parameter, kept for per-user routing later
export async function emailFor(_userId: string): Promise<EmailProvider> {
  return platformEmail();
}

// Magic-link and other platform email.
export function authEmailProvider(): EmailProvider {
  return platformEmail();
}

// The user's Stripe adapter, or null when Stripe is not connected. An OAuth connection (its
// account id is in account_label) acts through the platform key with stripeAccount. A
// restricted-key connection is used only when STRIPE_KEY_MODE=restricted.
export async function paymentsFor(userId: string): Promise<PaymentProvider | null> {
  const { rows } = await withService((c) =>
    c.query<{ secret_ciphertext: string | null; account_label: string }>(
      "select secret_ciphertext, account_label from connected_accounts where user_id = $1 and provider = 'stripe'",
      [userId],
    ),
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (isStripeAccountId(row.account_label)) {
    return new StripePaymentProvider(platformStripeClient(), { stripeAccount: row.account_label });
  }
  if (!restrictedKeyMode() || !row.secret_ciphertext) return null;
  const key = decryptSecret(row.secret_ciphertext);
  const stripe = new Stripe(key, { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 1 });
  return new StripePaymentProvider(stripe);
}
