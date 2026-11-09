-- Passkeys (WebAuthn) for everyday sign-in. The magic link stays as the fallback.
-- passkeys is user data: row-level security applies, so the account screen can list and remove keys.
-- webauthn_challenges carries no tenant data and is reached only by the service role.

create table passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  credential_id text not null unique,
  -- Base64url COSE public key, as returned by the WebAuthn library.
  public_key text not null,
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  label text not null default 'This device',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index passkeys_user on passkeys (user_id);

create table webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  purpose text not null check (purpose in ('login', 'register')),
  user_id uuid references users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table passkeys enable row level security;
alter table passkeys force row level security;
create policy tenant_isolation on passkeys
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

grant select, insert, update, delete on passkeys to app_rls, app_service;
grant select, insert, update, delete on webauthn_challenges to app_service;
revoke all on webauthn_challenges from app_rls;
