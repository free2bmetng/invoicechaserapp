-- OAuth connections store only the Stripe account id (account_label). Payments and
-- deauthorisation use the platform key with that account id, so no per-account access
-- token is kept. Restricted-key rows still carry their encrypted key.
alter table connected_accounts alter column secret_ciphertext drop not null;
