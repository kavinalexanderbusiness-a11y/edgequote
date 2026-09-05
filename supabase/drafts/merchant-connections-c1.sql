-- C1 OFFLINE DRAFT, UNAPPLIED. S106 must approve an exact schema-first plan.
-- Identity only: no capability grants, credentials, provider calls or backfill.
-- Existing merchant records and runtime paths remain unchanged.
begin;

create table public.merchant_connections (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references public.business_settings(user_id) on delete restrict,
  stripe_platform_account_id text not null check (stripe_platform_account_id ~ '^acct_[A-Za-z0-9_]{1,250}$'),
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9_]{1,250}$'),
  livemode boolean not null,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_connections_distinct_accounts check (stripe_platform_account_id <> stripe_account_id),
  constraint merchant_connections_account_mode_key unique (stripe_account_id, livemode),
  constraint merchant_connections_identity_key unique (id, user_id, stripe_platform_account_id, stripe_account_id, livemode)
);
create unique index merchant_connections_current_owner_idx
  on public.merchant_connections(user_id, stripe_platform_account_id, livemode)
  where disconnected_at is null;
create index merchant_connections_owner_idx on public.merchant_connections(user_id);

create table public.merchant_provider_objects (
  id uuid primary key default extensions.uuid_generate_v4(),
  connection_id uuid not null,
  user_id uuid not null,
  stripe_platform_account_id text not null,
  stripe_account_id text not null,
  livemode boolean not null,
  object_type text not null check (object_type in ('customer','payment_method','setup_intent','checkout_session','payment_intent','charge')),
  object_id text not null check (object_id ~ '^[A-Za-z0-9_]{1,255}$'),
  customer_id uuid,
  invoice_id uuid,
  quote_id uuid,
  created_at timestamptz not null default now(),
  constraint merchant_provider_objects_connection_fk
    foreign key (connection_id, user_id, stripe_platform_account_id, stripe_account_id, livemode)
    references public.merchant_connections(id, user_id, stripe_platform_account_id, stripe_account_id, livemode) on delete restrict,
  constraint merchant_provider_objects_customer_fk
    foreign key (user_id, customer_id) references public.customers(user_id, id) on delete restrict,
  constraint merchant_provider_objects_invoice_fk
    foreign key (user_id, invoice_id) references public.invoices(user_id, id) on delete restrict,
  constraint merchant_provider_objects_quote_fk
    foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete restrict,
  constraint merchant_provider_objects_identity_key unique (stripe_account_id, livemode, object_type, object_id),
  constraint merchant_provider_objects_target_check check (
    num_nonnulls(customer_id, invoice_id, quote_id) = 1
    and (object_type not in ('customer','payment_method','setup_intent') or customer_id is not null)
    and (object_type not in ('payment_intent','charge') or customer_id is null)
  ),
  constraint merchant_provider_objects_prefix_check check (
    object_id ~ (case object_type
      when 'customer' then '^cus_.+' when 'payment_method' then '^pm_.+'
      when 'setup_intent' then '^seti_.+' when 'checkout_session' then '^cs_.+'
      when 'payment_intent' then '^pi_.+' when 'charge' then '^ch_.+'
    end)
  )
);
create index merchant_provider_objects_connection_idx on public.merchant_provider_objects(connection_id);
create index merchant_provider_objects_customer_idx on public.merchant_provider_objects(user_id, customer_id) where customer_id is not null;
create index merchant_provider_objects_invoice_idx on public.merchant_provider_objects(user_id, invoice_id) where invoice_id is not null;
create index merchant_provider_objects_quote_idx on public.merchant_provider_objects(user_id, quote_id) where quote_id is not null;

create trigger merchant_connections_updated_at before update on public.merchant_connections
  for each row execute function public.handle_updated_at();

alter table public.merchant_connections enable row level security;
alter table public.merchant_provider_objects enable row level security;
revoke all on public.merchant_connections, public.merchant_provider_objects
  from public, anon, authenticated, service_role;
grant select, insert on public.merchant_connections, public.merchant_provider_objects to service_role;
-- Only disconnection/reconnection can change. Identity and targets are immutable.
-- The existing trigger owns updated_at; the caller cannot overwrite it directly.
grant update(disconnected_at) on public.merchant_connections to service_role;
-- No browser policies, grants, mutation RPCs or automatic cascading deletions.
commit;
