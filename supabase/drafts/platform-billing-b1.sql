-- B1 — OFFLINE DRAFT, NOT APPLIED. This file is outside the migration replay path.
-- S106 must assign the real migration version and approve the schema-first plan.
-- No seeds, signup triggers, backfill, provider calls or access enforcement.
-- Platform billing requires a DIFFERENT Stripe account from merchant payments.
begin;

create table public.platform_billing_accounts (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_account_id text not null check (stripe_account_id ~ '[^[:space:]]'),
  livemode boolean not null,
  stripe_customer_id text not null check (stripe_customer_id ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_billing_accounts_owner_scope_key unique (user_id, stripe_account_id, livemode),
  constraint platform_billing_accounts_customer_scope_key unique (stripe_account_id, livemode, stripe_customer_id),
  constraint platform_billing_accounts_mapping_key unique (id, user_id, stripe_account_id, livemode)
);

create table public.platform_subscriptions (
  id uuid primary key default extensions.uuid_generate_v4(),
  billing_account_id uuid not null,
  user_id uuid not null,
  stripe_account_id text not null,
  livemode boolean not null,
  stripe_subscription_id text not null check (stripe_subscription_id ~ '[^[:space:]]'),
  stripe_price_id text check (stripe_price_id is null or stripe_price_id ~ '[^[:space:]]'),
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null,
  cancel_at timestamptz,
  canceled_at timestamptz,
  ended_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_subscriptions_account_fk
    foreign key (billing_account_id, user_id, stripe_account_id, livemode)
    references public.platform_billing_accounts (id, user_id, stripe_account_id, livemode) on delete cascade,
  constraint platform_subscriptions_provider_key unique (stripe_account_id, livemode, stripe_subscription_id),
  constraint platform_subscriptions_trial_order check (trial_end >= trial_start),
  constraint platform_subscriptions_period_order check (current_period_end >= current_period_start)
);

-- Cancellation scheduled for later is still nonterminal and reserves the slot.
create unique index platform_subscriptions_one_nonterminal_idx
  on public.platform_subscriptions (billing_account_id)
  where status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused');
-- The partial index above cannot cover historical rows during a parent cascade.
create index platform_subscriptions_account_idx on public.platform_subscriptions (billing_account_id);
create index platform_subscriptions_owner_idx on public.platform_subscriptions (user_id);

create table public.platform_billing_events (
  stripe_account_id text not null check (stripe_account_id ~ '[^[:space:]]'),
  livemode boolean not null,
  event_id text not null check (event_id ~ '[^[:space:]]'),
  event_type text not null check (event_type ~ '[^[:space:]]'),
  event_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  state text not null default 'received' check (state in ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  processed_at timestamptz,
  -- Codes only: no raw provider response, exception, credential or card payload.
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$'),
  primary key (stripe_account_id, livemode, event_id),
  constraint platform_billing_events_completion_check
    check ((state in ('processed', 'ignored')) = (processed_at is not null)),
  constraint platform_billing_events_processing_lease_check
    check (state <> 'processing' or lease_until is not null)
);
create index platform_billing_events_recovery_idx
  on public.platform_billing_events (state, lease_until, received_at);

create trigger platform_billing_accounts_updated_at
  before update on public.platform_billing_accounts
  for each row execute function public.handle_updated_at();
create trigger platform_subscriptions_updated_at
  before update on public.platform_subscriptions
  for each row execute function public.handle_updated_at();

alter table public.platform_billing_accounts enable row level security;
alter table public.platform_subscriptions enable row level security;
alter table public.platform_billing_events enable row level security;

-- Revoke explicit defaults too; PUBLIC revocation alone does not remove them.
revoke all on public.platform_billing_accounts, public.platform_subscriptions, public.platform_billing_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on public.platform_billing_accounts, public.platform_subscriptions, public.platform_billing_events to service_role;
grant select on public.platform_billing_accounts, public.platform_subscriptions to authenticated;

create policy "billing accounts: owner read" on public.platform_billing_accounts
  for select to authenticated using (
    platform_billing_accounts.user_id = (select auth.uid())
    and exists (select 1 from public.business_settings bs where bs.user_id = (select auth.uid()))
  );
create policy "subscriptions: owner read" on public.platform_subscriptions
  for select to authenticated using (
    platform_subscriptions.user_id = (select auth.uid())
    and exists (select 1 from public.business_settings bs where bs.user_id = (select auth.uid()))
  );
-- Events have zero policies and no browser/anon grants. No browser mutation RPC.
commit;
