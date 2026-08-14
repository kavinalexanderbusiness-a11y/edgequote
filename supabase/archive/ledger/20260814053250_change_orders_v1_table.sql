-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053250
--   name    : change_orders_v1_table
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.change_orders (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  job_id       uuid not null,
  customer_id  uuid not null,
  quote_id     uuid,
  co_number    text not null,
  description  text not null,
  amount       numeric(12,2) not null,
  service_key      text,
  service_category text,
  status       text not null default 'draft',
  decided_via  text,
  decline_reason text,
  sent_at      timestamptz,
  approved_at  timestamptz,
  declined_at  timestamptz,
  cancelled_at timestamptz,
  constraint change_orders_job_same_owner
    foreign key (job_id, user_id) references public.jobs (id, user_id) on delete cascade,
  constraint change_orders_customer_same_owner
    foreign key (user_id, customer_id) references public.customers (user_id, id) on delete cascade,
  constraint change_orders_quote_same_owner
    foreign key (user_id, quote_id) references public.quotes (user_id, id) on delete set null,
  constraint change_orders_status_check
    check (status in ('draft', 'pending', 'approved', 'declined', 'cancelled')),
  constraint change_orders_amount_check check (amount > 0),
  constraint change_orders_description_check check (length(btrim(description)) > 0),
  constraint change_orders_decided_via_check
    check (decided_via is null or decided_via in ('portal', 'owner')),
  constraint change_orders_status_stamps check (
       (status = 'draft'     and sent_at is null     and approved_at is null and declined_at is null and cancelled_at is null)
    or (status = 'pending'   and sent_at is not null and approved_at is null and declined_at is null and cancelled_at is null)
    or (status = 'approved'  and approved_at is not null and declined_at is null and cancelled_at is null)
    or (status = 'declined'  and declined_at is not null and approved_at is null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and approved_at is null and declined_at is null)
  ),
  constraint change_orders_decided_via_present check (
    (status in ('approved', 'declined')) = (decided_via is not null)
  ),
  constraint change_orders_id_user_key unique (id, user_id)
);

create unique index if not exists change_orders_number_uniq
  on public.change_orders (user_id, co_number);
create index if not exists change_orders_job_idx on public.change_orders (job_id);
create index if not exists change_orders_customer_idx on public.change_orders (customer_id, status);

alter table public.change_orders enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='change_orders' and policyname='change_orders: select own') then
    create policy "change_orders: select own" on public.change_orders for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='change_orders' and policyname='change_orders: insert own') then
    create policy "change_orders: insert own" on public.change_orders for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='change_orders' and policyname='change_orders: update own') then
    create policy "change_orders: update own" on public.change_orders for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

comment on table public.change_orders is
  'Scope + price agreed AFTER the original approval. Owns the AUTHORIZATION only - approval mints a job_line_items row (change_order_id), which is the money. The originating quote is never rewritten.';
comment on column public.change_orders.decided_via is
  'portal = the customer decided it themselves; owner = the owner recorded a decision taken elsewhere. Never inferred - no surface may imply a customer tapped approve when they did not.';