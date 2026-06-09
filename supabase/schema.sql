-- ============================================================
-- EdgeQuote AI — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ============================================================

-- Enable UUID extension (usually already enabled)
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────
-- CUSTOMERS
-- ────────────────────────────────────────────────
create table public.customers (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  name        text not null,
  email       text,
  phone       text,
  address     text,
  city        text,
  province    text default 'AB',
  postal_code text,
  notes       text,

  -- owner — ties rows to the authenticated user
  user_id     uuid not null references auth.users(id) on delete cascade
);

-- ────────────────────────────────────────────────
-- QUOTES
-- ────────────────────────────────────────────────
create table public.quotes (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  quote_number  text not null,          -- e.g. "EPS-2025-0001"
  customer_id   uuid references public.customers(id) on delete set null,
  customer_name text not null,          -- denormalised for history integrity

  -- service details
  address       text not null,
  service_type  text not null,
  notes         text,

  -- pricing inputs
  hours         numeric(6,2) not null default 1,
  crew_size     int          not null default 1,
  rate          numeric(8,2) not null default 50.00,
  travel_fee    numeric(8,2) not null default 0,

  -- typed prices (source of truth). initial_price is the main/first-visit price;
  -- weekly/biweekly/monthly are optional per-visit maintenance prices.
  initial_price  numeric(10,2),
  weekly_price   numeric(10,2),
  biweekly_price numeric(10,2),
  monthly_price  numeric(10,2),

  -- computed (also stored for history)
  man_hours     numeric(8,2) generated always as (hours * crew_size) stored,
  subtotal      numeric(10,2) generated always as (hours * crew_size * rate) stored,
  total         numeric(10,2) generated always as (coalesce(initial_price, hours * crew_size * rate) + coalesce(travel_fee, 0)) stored,

  -- status
  status        text not null default 'draft'
                check (status in ('draft','sent','accepted','declined')),

  user_id       uuid not null references auth.users(id) on delete cascade
);

-- ────────────────────────────────────────────────
-- Auto-update updated_at
-- ────────────────────────────────────────────────
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger customers_updated_at
  before update on public.customers
  for each row execute procedure public.handle_updated_at();

create trigger quotes_updated_at
  before update on public.quotes
  for each row execute procedure public.handle_updated_at();

-- ────────────────────────────────────────────────
-- ROW LEVEL SECURITY — users only see their own data
-- ────────────────────────────────────────────────
alter table public.customers enable row level security;
alter table public.quotes     enable row level security;

-- Customers
create policy "customers: select own"
  on public.customers for select
  using (auth.uid() = user_id);

create policy "customers: insert own"
  on public.customers for insert
  with check (auth.uid() = user_id);

create policy "customers: update own"
  on public.customers for update
  using (auth.uid() = user_id);

create policy "customers: delete own"
  on public.customers for delete
  using (auth.uid() = user_id);

-- Quotes
create policy "quotes: select own"
  on public.quotes for select
  using (auth.uid() = user_id);

create policy "quotes: insert own"
  on public.quotes for insert
  with check (auth.uid() = user_id);

create policy "quotes: update own"
  on public.quotes for update
  using (auth.uid() = user_id);

create policy "quotes: delete own"
  on public.quotes for delete
  using (auth.uid() = user_id);

-- ────────────────────────────────────────────────
-- INDEXES
-- ────────────────────────────────────────────────
create index customers_user_id_idx on public.customers(user_id);
create index customers_name_idx    on public.customers(name);
create index quotes_user_id_idx    on public.quotes(user_id);
create index quotes_status_idx     on public.quotes(status);
create index quotes_created_idx    on public.quotes(created_at desc);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-09 — Measurement sections, travel + pricing
-- intelligence capture. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════

-- Measurement provenance + per-section breakdown + travel/confidence capture.
-- (measured_sqft / suggested_price were added in a prior step; included here so a
--  fresh deploy from this file reproduces a complete quotes table.)
alter table public.quotes
  add column if not exists measured_sqft      numeric,
  add column if not exists suggested_price    numeric,
  add column if not exists front_lawn_sqft    numeric,
  add column if not exists back_lawn_sqft     numeric,
  add column if not exists left_side_sqft     numeric,
  add column if not exists right_side_sqft    numeric,
  add column if not exists boulevard_sqft     numeric,
  add column if not exists other_sqft         numeric,
  add column if not exists travel_distance_km numeric,
  add column if not exists pricing_confidence text;

-- Constrain confidence to the known set (NULL allowed for un-scored quotes).
alter table public.quotes drop constraint if exists quotes_pricing_confidence_chk;
alter table public.quotes add constraint quotes_pricing_confidence_chk
  check (pricing_confidence is null or pricing_confidence in ('high','medium','low'));

-- Actual minutes on site (planned vs. actual time → future pricing intelligence).
alter table public.jobs
  add column if not exists actual_minutes integer;

-- properties.measurement_history (jsonb) already exists and now stores versioned
-- snapshots { date, total_sqft, sections{...}, rate_per_1000 } — never overwritten.
