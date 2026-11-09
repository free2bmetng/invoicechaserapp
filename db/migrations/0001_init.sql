-- Invoice Chaser v1 schema.
-- Every user-owned table carries user_id and is protected by row-level security.
-- The request role (app_rls) is subject to RLS; the service role (app_service,
-- BYPASSRLS) is used only by the sender cron and webhooks, and every query it
-- runs must still filter by user_id.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  created_at timestamptz not null default now()
);

create table settings (
  user_id uuid primary key references users(id) on delete cascade,
  sender_name text not null default '',
  business_name text not null default '',
  postal_address text not null default '',
  timezone text not null default 'UTC',
  -- Users may narrow the 09:00-17:00 window, never widen it. Whole hours in v1.
  send_window_start smallint not null default 9
    check (send_window_start >= 9 and send_window_start < 17),
  send_window_end smallint not null default 17
    check (send_window_end <= 17 and send_window_end > send_window_start),
  daily_cap integer not null default 20 check (daily_cap >= 1),
  digest_hour smallint not null default 8 check (digest_hour between 0 and 23),
  digest_enabled boolean not null default true,
  sending_provider text not null default 'fake'
    check (sending_provider in ('fake', 'resend', 'postmark')),
  sending_domain text,
  onboarding_done boolean not null default false,
  updated_at timestamptz not null default now()
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  -- Match key for CSV import. Always stored lower-cased.
  email text not null check (email = lower(email)),
  timezone text,
  sequence_id uuid,
  auto_send boolean not null default false,
  reply_held_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, email)
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  email text not null check (email = lower(email)),
  name text not null default '',
  is_primary boolean not null default false,
  -- null = active. 'bounced' is set by a bounce; 'paused' is a user hold.
  hold text check (hold in ('bounced', 'paused')),
  created_at timestamptz not null default now(),
  unique (user_id, client_id, email)
);
create unique index contacts_one_primary on contacts (client_id) where is_primary;

create table sequences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('standard', 'plan')),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index sequences_one_default on sequences (user_id, kind) where is_default;

alter table clients
  add constraint clients_sequence_fk foreign key (sequence_id)
  references sequences (id) on delete set null;

create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  sequence_id uuid not null references sequences (id) on delete cascade,
  position integer not null check (position >= 0),
  -- Signed whole days relative to the due date (negative = before).
  offset_days integer not null,
  tone text not null check (tone in ('friendly', 'neutral', 'firm', 'custom')),
  subject text not null,
  body text not null,
  requires_approval boolean not null default false,
  is_final_notice boolean not null default false,
  unique (sequence_id, position)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  invoice_number text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  issue_date date not null,
  due_date date not null,
  status text not null default 'open'
    check (status in ('open', 'paid', 'paused', 'disputed', 'payment_plan', 'written_off')),
  paid_at timestamptz,
  notes text not null default '',
  sequence_id uuid references sequences (id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'csv', 'stripe')),
  external_id text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_link_amount_minor bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_id, invoice_number),
  check (due_date >= issue_date)
);

create table invoice_contacts (
  user_id uuid not null references users(id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  role text not null check (role in ('primary', 'cc')),
  primary key (invoice_id, contact_id)
);
create unique index invoice_contacts_one_primary on invoice_contacts (invoice_id) where role = 'primary';

create table payment_plan_installments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  position integer not null check (position >= 1),
  due_date date not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'open' check (status in ('open', 'paid')),
  paid_at timestamptz,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_link_amount_minor bigint,
  unique (invoice_id, position)
);

create table scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  installment_id uuid references payment_plan_installments (id) on delete cascade,
  step_id uuid references sequence_steps (id) on delete set null,
  contact_id uuid not null references contacts (id) on delete cascade,
  planned_at timestamptz not null,
  status text not null check (status in (
    'pending_approval', 'scheduled', 'held', 'sending',
    'sent', 'delivered', 'bounced', 'failed', 'needs_check',
    'cancelled', 'skipped')),
  -- Status to restore on resume (cancelled and held rows only).
  prior_status text,
  requires_approval boolean not null default false,
  subject_override text,
  body_override text,
  claimed_at timestamptz,
  -- Application-computed, never null. Enforces one row per planned step.
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (installment_id is not null or step_id is not null)
);
create index scheduled_messages_due on scheduled_messages (planned_at) where status = 'scheduled';
create index scheduled_messages_user_status on scheduled_messages (user_id, status);
create index scheduled_messages_invoice on scheduled_messages (invoice_id);

create table message_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  scheduled_message_id uuid not null unique references scheduled_messages (id) on delete cascade,
  invoice_id uuid references invoices (id) on delete set null,
  contact_id uuid references contacts (id) on delete set null,
  recipient_email text not null,
  cc_emails text[] not null default '{}',
  subject text not null,
  body_snapshot text not null,
  provider text not null,
  provider_message_id text,
  sent_at timestamptz not null default now(),
  delivery_status text not null default 'sent'
    check (delivery_status in ('sent', 'delivered', 'bounced', 'failed')),
  manual boolean not null default false
);
create unique index message_log_provider_message on message_log (provider, provider_message_id)
  where provider_message_id is not null;

create table events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  invoice_id uuid references invoices (id) on delete cascade,
  client_id uuid references clients (id) on delete cascade,
  type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_user_time on events (user_id, created_at desc);

create table connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'gmail', 'outlook')),
  -- AES-256-GCM, encoded as base64(iv):base64(tag):base64(ciphertext).
  secret_ciphertext text not null,
  account_label text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table stripe_events (
  event_id text primary key,
  user_id uuid references users (id) on delete cascade,
  processed_at timestamptz not null default now()
);

create table digests (
  user_id uuid not null references users (id) on delete cascade,
  digest_date date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, digest_date)
);

-- Auth tables carry no tenant data and are reached only by the service role.
create table login_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Row-level security. FORCE applies it to the table owner as well.
do $$
declare t text;
begin
  foreach t in array array[
    'settings', 'clients', 'contacts', 'sequences', 'sequence_steps', 'invoices',
    'invoice_contacts', 'payment_plan_installments', 'scheduled_messages',
    'message_log', 'events', 'connected_accounts', 'stripe_events', 'digests'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
         with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
  end loop;
end $$;

alter table users enable row level security;
alter table users force row level security;
create policy self_only on users
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Grants. app_rls is the request role; app_service is the cron/webhook role.
grant usage on schema public to app_rls, app_service;
grant select, insert, update, delete on all tables in schema public to app_rls, app_service;
grant usage, select on all sequences in schema public to app_rls, app_service;
revoke all on login_tokens, sessions from app_rls;
