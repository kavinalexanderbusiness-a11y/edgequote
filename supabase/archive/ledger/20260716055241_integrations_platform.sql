-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716055241
--   name    : integrations_platform
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15 — Integrations platform (API keys, webhooks, outbox).
-- Mirror of supabase/RUN-2026-07-15-integrations-platform.sql (committed).
-- ════════════════════════════════════════════════════════════

-- (1) API keys — hashed at rest; prefix kept for display only.
create table if not exists public.api_keys (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  prefix          text not null,
  key_hash        text not null unique,
  scopes          text[] not null default '{read}',
  last_used_at    timestamptz,
  usage_count     bigint not null default 0,
  rl_window_start timestamptz,
  rl_count        int not null default 0,
  revoked_at      timestamptz
);
alter table public.api_keys enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='api_keys' and policyname='api_keys: select own') then
    create policy "api_keys: select own" on public.api_keys for select using (auth.uid() = user_id);
    create policy "api_keys: insert own" on public.api_keys for insert with check (auth.uid() = user_id);
    create policy "api_keys: update own" on public.api_keys for update using (auth.uid() = user_id);
    create policy "api_keys: delete own" on public.api_keys for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, insert, update, delete on public.api_keys to authenticated;
create index if not exists api_keys_user_idx on public.api_keys(user_id);

-- (2) Outbound webhook endpoints.
create table if not exists public.webhook_endpoints (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  url                  text not null,
  description          text,
  secret               text not null,
  events               text[] not null default '{*}',
  source               text not null default 'manual' check (source in ('manual','api','zapier','make')),
  active               boolean not null default true,
  disabled_reason      text,
  consecutive_failures int not null default 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz
);
alter table public.webhook_endpoints enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='webhook_endpoints' and policyname='webhook_endpoints: select own') then
    create policy "webhook_endpoints: select own" on public.webhook_endpoints for select using (auth.uid() = user_id);
    create policy "webhook_endpoints: insert own" on public.webhook_endpoints for insert with check (auth.uid() = user_id);
    create policy "webhook_endpoints: update own" on public.webhook_endpoints for update using (auth.uid() = user_id);
    create policy "webhook_endpoints: delete own" on public.webhook_endpoints for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, insert, update, delete on public.webhook_endpoints to authenticated;
create index if not exists webhook_endpoints_user_idx on public.webhook_endpoints(user_id);
drop trigger if exists webhook_endpoints_updated_at on public.webhook_endpoints;
create trigger webhook_endpoints_updated_at before update on public.webhook_endpoints
  for each row execute function public.handle_updated_at();

-- (3) The event outbox.
create table if not exists public.integration_events (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  event       text not null,
  entity_type text not null,
  entity_id   uuid,
  payload     jsonb not null default '{}'::jsonb
);
alter table public.integration_events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='integration_events' and policyname='integration_events: select own') then
    create policy "integration_events: select own" on public.integration_events for select using (auth.uid() = user_id);
    create policy "integration_events: delete own" on public.integration_events for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, delete on public.integration_events to authenticated;
create index if not exists integration_events_user_idx on public.integration_events(user_id, created_at desc);
create index if not exists integration_events_kind_idx on public.integration_events(user_id, event, created_at desc);

-- (4) Deliveries — retry queue AND permanent delivery log.
create table if not exists public.webhook_deliveries (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  endpoint_id     uuid not null references public.webhook_endpoints(id) on delete cascade,
  event_id        uuid references public.integration_events(id) on delete set null,
  event           text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending' check (status in ('pending','processing','success','dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  delivered_at    timestamptz,
  response_status int,
  response_body   text,
  duration_ms     int,
  last_error      text
);
alter table public.webhook_deliveries enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='webhook_deliveries' and policyname='webhook_deliveries: select own') then
    create policy "webhook_deliveries: select own" on public.webhook_deliveries for select using (auth.uid() = user_id);
    create policy "webhook_deliveries: insert own" on public.webhook_deliveries for insert with check (auth.uid() = user_id);
    create policy "webhook_deliveries: update own" on public.webhook_deliveries for update using (auth.uid() = user_id);
    create policy "webhook_deliveries: delete own" on public.webhook_deliveries for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, insert, update, delete on public.webhook_deliveries to authenticated;
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries(status, next_attempt_at) where status = 'pending';
create index if not exists webhook_deliveries_user_idx on public.webhook_deliveries(user_id, created_at desc);
create index if not exists webhook_deliveries_endpoint_idx on public.webhook_deliveries(endpoint_id, created_at desc);

-- (5) Inbound webhooks.
create table if not exists public.inbound_webhooks (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  name             text not null,
  token            text not null unique,
  action           text not null default 'lead' check (action in ('lead','customer')),
  active           boolean not null default true,
  received_count   int not null default 0,
  last_received_at timestamptz
);
alter table public.inbound_webhooks enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inbound_webhooks' and policyname='inbound_webhooks: select own') then
    create policy "inbound_webhooks: select own" on public.inbound_webhooks for select using (auth.uid() = user_id);
    create policy "inbound_webhooks: insert own" on public.inbound_webhooks for insert with check (auth.uid() = user_id);
    create policy "inbound_webhooks: update own" on public.inbound_webhooks for update using (auth.uid() = user_id);
    create policy "inbound_webhooks: delete own" on public.inbound_webhooks for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, insert, update, delete on public.inbound_webhooks to authenticated;
create index if not exists inbound_webhooks_user_idx on public.inbound_webhooks(user_id);

-- (6) Inbound receipts.
create table if not exists public.inbound_events (
  id         uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  hook_id    uuid not null references public.inbound_webhooks(id) on delete cascade,
  ok         boolean not null,
  summary    text,
  entity_id  uuid,
  payload    jsonb not null default '{}'::jsonb
);
alter table public.inbound_events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inbound_events' and policyname='inbound_events: select own') then
    create policy "inbound_events: select own" on public.inbound_events for select using (auth.uid() = user_id);
    create policy "inbound_events: delete own" on public.inbound_events for delete using (auth.uid() = user_id);
  end if;
end $$;
grant select, delete on public.inbound_events to authenticated;
create index if not exists inbound_events_hook_idx on public.inbound_events(hook_id, created_at desc);

-- (7) Server-only delivery-nudge config (push_config pattern).
create table if not exists public.integrations_config (
  id          int primary key default 1,
  deliver_url text,
  secret      text,
  constraint integrations_config_singleton check (id = 1)
);
insert into public.integrations_config (id) values (1) on conflict (id) do nothing;
alter table public.integrations_config enable row level security;
revoke all on public.integrations_config from anon, authenticated;

-- (8) Event capture — ONE function, six domain tables.
create or replace function public.capture_integration_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event text; v_entity text; v_id uuid; v_user uuid; v_payload jsonb;
begin
  if tg_table_name = 'customers' then
    v_entity := 'customer'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT' then
      v_event := 'customer.created';
      v_payload := jsonb_build_object('id', new.id, 'name', new.name, 'email', new.email,
        'phone', new.phone, 'address', new.address, 'city', new.city,
        'acquisition_source', new.acquisition_source, 'created_at', new.created_at);
    end if;
  elsif tg_table_name = 'quotes' then
    v_entity := 'quote'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'quote_number', new.quote_number,
      'customer_id', new.customer_id, 'customer_name', new.customer_name,
      'service_type', new.service_type, 'status', new.status, 'total', new.total,
      'address', new.address, 'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'quote.created';
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      if new.status = 'accepted' then v_event := 'quote.accepted';
      elsif new.status = 'declined' then v_event := 'quote.declined';
      end if;
    end if;
  elsif tg_table_name = 'jobs' then
    v_entity := 'job'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
      'title', new.title, 'service_type', new.service_type, 'status', new.status,
      'scheduled_date', new.scheduled_date, 'price', new.price, 'crew_id', new.crew_id,
      'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'job.created';
    elsif tg_op = 'UPDATE' and new.status = 'completed' and old.status is distinct from 'completed' then
      v_event := 'job.completed';
      v_payload := v_payload || jsonb_build_object('completed_at', new.completed_at, 'actual_minutes', new.actual_minutes);
    end if;
  elsif tg_table_name = 'invoices' then
    v_entity := 'invoice'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'invoice_number', new.invoice_number,
      'customer_id', new.customer_id, 'customer_name', new.customer_name,
      'status', new.status, 'amount', new.amount, 'amount_paid', new.amount_paid,
      'due_date', new.due_date, 'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'invoice.created';
    elsif tg_op = 'UPDATE' and new.status = 'paid' and old.status is distinct from 'paid' then
      v_event := 'invoice.paid';
      v_payload := v_payload || jsonb_build_object('paid_at', new.paid_at);
    end if;
  elsif tg_table_name = 'payments' then
    v_entity := 'payment'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT' and coalesce(new.status, 'paid') in ('paid','succeeded') then
      v_event := 'payment.recorded';
      v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
        'invoice_id', new.invoice_id, 'amount', new.amount, 'currency', new.currency,
        'method', new.method, 'kind', new.kind, 'paid_at', new.paid_at, 'created_at', new.created_at);
    end if;
  elsif tg_table_name = 'service_requests' then
    v_entity := 'request'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT' then
      v_event := 'request.created';
      v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
        'message', new.message, 'status', new.status, 'created_at', new.created_at);
    end if;
  end if;

  if v_event is null or v_user is null then return new; end if;

  if not exists (select 1 from public.webhook_endpoints e where e.user_id = v_user and e.active)
     and not exists (select 1 from public.api_keys k where k.user_id = v_user and k.revoked_at is null)
  then return new; end if;

  begin
    insert into public.integration_events (user_id, event, entity_type, entity_id, payload)
    values (v_user, v_event, v_entity, v_id, v_payload);
  exception when others then
    null;
  end;
  return new;
end; $$;

drop trigger if exists trg_integration_capture on public.customers;
create trigger trg_integration_capture after insert on public.customers
  for each row execute function public.capture_integration_event();
drop trigger if exists trg_integration_capture on public.quotes;
create trigger trg_integration_capture after insert or update of status on public.quotes
  for each row execute function public.capture_integration_event();
drop trigger if exists trg_integration_capture on public.jobs;
create trigger trg_integration_capture after insert or update of status on public.jobs
  for each row execute function public.capture_integration_event();
drop trigger if exists trg_integration_capture on public.invoices;
create trigger trg_integration_capture after insert or update of status on public.invoices
  for each row execute function public.capture_integration_event();
drop trigger if exists trg_integration_capture on public.payments;
create trigger trg_integration_capture after insert on public.payments
  for each row execute function public.capture_integration_event();
drop trigger if exists trg_integration_capture on public.service_requests;
create trigger trg_integration_capture after insert on public.service_requests
  for each row execute function public.capture_integration_event();

-- (9) Fan-out: one delivery row per matching active endpoint.
create or replace function public.fanout_integration_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.webhook_deliveries (user_id, endpoint_id, event_id, event, payload)
  select new.user_id, e.id, new.id, new.event, new.payload
  from public.webhook_endpoints e
  where e.user_id = new.user_id and e.active
    and ('*' = any(e.events) or new.event = any(e.events));
  return new;
end; $$;
drop trigger if exists trg_integration_fanout on public.integration_events;
create trigger trg_integration_fanout after insert on public.integration_events
  for each row execute function public.fanout_integration_event();

-- (10) Nudge the app to deliver NOW (statement-level, best-effort).
create or replace function public.nudge_webhook_deliveries()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select deliver_url, secret into v_url, v_secret from public.integrations_config where id = 1;
  if v_url is null or v_url = '' then return null; end if;
  begin
    perform net.http_post(
      url     := v_url,
      body    := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-integrations-secret', coalesce(v_secret, ''))
    );
  exception when others then
    null;
  end;
  return null;
end; $$;
drop trigger if exists trg_webhook_deliveries_nudge on public.webhook_deliveries;
create trigger trg_webhook_deliveries_nudge after insert on public.webhook_deliveries
  for each statement execute function public.nudge_webhook_deliveries();

revoke execute on function public.capture_integration_event() from public, anon, authenticated;
revoke execute on function public.fanout_integration_event() from public, anon, authenticated;
revoke execute on function public.nudge_webhook_deliveries() from public, anon, authenticated;

do $$ begin
  alter publication supabase_realtime add table public.webhook_deliveries;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.inbound_events;
exception when duplicate_object then null; end $$;
alter table public.webhook_deliveries replica identity full;
alter table public.inbound_events replica identity full;

-- (11) API-key authentication + fixed-window rate limit in ONE round trip.
create or replace function public.authenticate_api_key(p_hash text)
returns table (key_id uuid, key_user_id uuid, key_name text, key_scopes text[], rate_limited boolean)
language sql security definer set search_path = public as $$
  update public.api_keys k set
    last_used_at    = now(),
    usage_count     = k.usage_count + 1,
    rl_count        = case when k.rl_window_start is null or k.rl_window_start < now() - interval '1 minute'
                           then 1 else k.rl_count + 1 end,
    rl_window_start = case when k.rl_window_start is null or k.rl_window_start < now() - interval '1 minute'
                           then now() else k.rl_window_start end
  where k.key_hash = p_hash and k.revoked_at is null
  returning k.id, k.user_id, k.name, k.scopes, (k.rl_count > 120);
$$;
revoke all on function public.authenticate_api_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_api_key(text) to service_role;

-- (12) Atomically claim due deliveries (SKIP LOCKED).
create or replace function public.claim_webhook_deliveries(p_limit int default 25, p_user uuid default null)
returns setof public.webhook_deliveries
language sql security definer set search_path = public as $$
  update public.webhook_deliveries d
  set status = 'processing', attempts = d.attempts + 1, last_attempt_at = now()
  where d.id in (
    select id from public.webhook_deliveries
    where status = 'pending' and next_attempt_at <= now()
      and (p_user is null or user_id = p_user)
    order by next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 25), 50))
    for update skip locked
  )
  returning d.*;
$$;
revoke all on function public.claim_webhook_deliveries(int, uuid) from public, anon, authenticated;
grant execute on function public.claim_webhook_deliveries(int, uuid) to service_role;