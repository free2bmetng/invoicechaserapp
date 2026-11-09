-- Each Stripe connection gets its own webhook endpoint and signing secret, because
-- Stripe signs every endpoint with that endpoint's own secret. The public route is
-- /api/webhooks/stripe/<webhook_token>, which looks up the secret for that connection.
alter table connected_accounts
  add column webhook_token text unique,
  add column webhook_secret_ciphertext text,
  add column stripe_webhook_endpoint_id text;
