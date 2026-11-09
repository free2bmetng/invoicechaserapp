// The Stripe clients the platform uses. This is the only module that builds Stripe clients for
// the Connect OAuth path, so tests replace it with a fake and nothing reaches the network.
//
// STRIPE_SECRET_KEY is the platform's own secret key. It makes the OAuth token exchange and
// deauthorize calls. Payment calls for a connected account pass stripeAccount instead of a key.
import Stripe from "stripe";
import type { StripeLinksClient } from "./stripe";

const STRIPE_TIMEOUT_MS = 10_000;

export interface StripeOAuthClient {
  oauth: {
    token(params: {
      grant_type: "authorization_code";
      code: string;
    }): Promise<{ stripe_user_id?: string; access_token?: string; livemode?: boolean }>;
    deauthorize(params: { client_id: string; stripe_user_id: string }): Promise<unknown>;
  };
}

export type StripePlatformClient = StripeLinksClient & StripeOAuthClient;

// The restricted-key path is for internal testing only. It is off unless STRIPE_KEY_MODE is
// exactly "restricted".
export function restrictedKeyMode(): boolean {
  return process.env.STRIPE_KEY_MODE === "restricted";
}

export function platformStripeClient(): StripePlatformClient {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 1 }) as unknown as StripePlatformClient;
}
