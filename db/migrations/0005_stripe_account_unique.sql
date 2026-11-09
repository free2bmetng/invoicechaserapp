-- One Stripe account (acct_...) can be connected to one user only. This guards the
-- OAuth rows against a race between two sign-ins. Restricted-key rows are not affected.
create unique index connected_accounts_stripe_account_unique
  on connected_accounts (account_label)
  where provider = 'stripe' and account_label like 'acct\_%';
