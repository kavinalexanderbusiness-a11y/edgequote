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

-- Per-visit price (manual override — wins over the linked quote's cadence price).
alter table public.jobs
  add column if not exists price numeric;

-- Configurable lawn pricing (consumed by the centralized pricing engine).
alter table public.business_settings
  add column if not exists pricing_base_charge      numeric default 28,
  add column if not exists pricing_mow_rate         numeric default 15,
  add column if not exists pricing_recommended_mult numeric default 1.0,
  add column if not exists pricing_premium_mult     numeric default 1.2,
  add column if not exists pricing_travel_rate      numeric default 1.5;

-- Preferred work days for the weekly scheduler. date-fns getDay indices
-- (0=Sun … 6=Sat). Default {5,6,0} = Fri/Sat/Sun. The scheduler strongly prefers
-- these days so routes cluster across the owner's actual work week.
alter table public.business_settings
  add column if not exists preferred_work_days integer[] default '{5,6,0}';

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-10 — Work-day timing, branding scale,
-- dashboard layout. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════

-- Work day start ('HH:mm') drives per-stop arrival ETAs + estimated finish.
-- Daily capacity (hours) powers the overloaded / room-for-more day signals.
-- logo_scale = uploaded-logo display size in percent (sidebar, login, PDFs).
-- dashboard_cards = home layout: { "order": [...], "hidden": [...] }.
alter table public.business_settings
  add column if not exists work_start_time      text    default '08:00',
  add column if not exists daily_capacity_hours numeric default 8,
  add column if not exists logo_scale           numeric default 100,
  add column if not exists dashboard_cards      jsonb;

-- Real community name ("Queensland"), reverse-geocoded once from the property's
-- coordinates. All neighborhood analytics prefer this over the postal FSA prefix
-- (fallback chain: neighborhood → FSA → city). Backfill via Data Quality →
-- "Name all"; new geocodes fill it automatically.
alter table public.properties
  add column if not exists neighborhood text;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-10 — Neighbor leads (door-knock prospects).
-- Prospects stay SEPARATE from customers: no customer record is
-- created until conversion, then linked via converted_customer_id.
-- ════════════════════════════════════════════════════════════
create table if not exists public.neighbor_leads (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  user_id               uuid not null references auth.users(id) on delete cascade,

  address               text not null,
  latitude              double precision,
  longitude             double precision,
  neighborhood          text,
  notes                 text,

  status                text not null default 'prospect'
                        check (status in ('prospect','contacted','quoted','won','lost')),

  -- Where this lead came from (the anchor customer whose neighbor it is).
  source_customer_id    uuid references public.customers(id) on delete set null,
  source_property_id    uuid references public.properties(id) on delete set null,
  source_quote_id       uuid references public.quotes(id) on delete set null,
  -- Filled on conversion — the ONLY link between a lead and a customer record.
  converted_customer_id uuid references public.customers(id) on delete set null
);

alter table public.neighbor_leads enable row level security;
create policy "neighbor_leads: select own" on public.neighbor_leads for select using (auth.uid() = user_id);
create policy "neighbor_leads: insert own" on public.neighbor_leads for insert with check (auth.uid() = user_id);
create policy "neighbor_leads: update own" on public.neighbor_leads for update using (auth.uid() = user_id);
create policy "neighbor_leads: delete own" on public.neighbor_leads for delete using (auth.uid() = user_id);

create index if not exists neighbor_leads_user_idx   on public.neighbor_leads(user_id);
create index if not exists neighbor_leads_status_idx on public.neighbor_leads(status);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-10 — Job check-in/check-out timestamps.
-- ▶ Start Job stamps started_at (arrival); ✓ Complete Job stamps
-- completed_at and auto-fills actual_minutes from the difference.
-- One timing system: actual_minutes stays the value every engine
-- (profitability, routes, pricing) already reads.
-- ════════════════════════════════════════════════════════════
alter table public.jobs
  add column if not exists started_at   timestamptz,
  add column if not exists completed_at timestamptz;

-- properties.measurement_history (jsonb) already exists and now stores versioned
-- snapshots { date, total_sqft, sections{...}, rate_per_1000 } — never overwritten.

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-12 — Service seasons (lawn/snow).
-- Recurring lawn/snow services default to their season's end date.
-- Stored as recurring month/day anchors: { lawn:{startMonth,startDay,
-- endMonth,endDay}, snow:{...} }. null = Calgary defaults in code.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists service_seasons jsonb;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-12 — Per-customer/property scheduling
-- preferences. Honoured by manual scheduling (soft warnings),
-- the whole-schedule optimizer, and the weekly Best-Day picker so
-- real customer commitments ("always Fridays", "never Sundays",
-- "mornings only") are respected, not just the owner's work days.
--
--   preferred_days  — weekday indices (date-fns getDay: 0=Sun…6=Sat)
--                     the customer likes; empty/null = no preference.
--   avoid_days      — weekday indices to keep them OFF.
--   pref_time_start / pref_time_end — 'HH:mm' preferred start window.
--
-- Preferences resolve per-field: a property value overrides the
-- customer default for that field only (see lib/preferences).
-- Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
alter table public.customers
  add column if not exists preferred_days  integer[],
  add column if not exists avoid_days      integer[],
  add column if not exists pref_time_start text,
  add column if not exists pref_time_end   text;

alter table public.properties
  add column if not exists preferred_days  integer[],
  add column if not exists avoid_days      integer[],
  add column if not exists pref_time_start text,
  add column if not exists pref_time_end   text;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-12 — Road-distance cache. Pairwise real-road
-- distances (Google Distance Matrix) for the small set of points
-- that actually appear on routes, fetched once and reused so Day
-- Ops route numbers are real-road instead of straight-line —
-- without re-billing the API on every view. Keys are rounded
-- "lat,lng" strings (≈11 m grid). Haversine remains the fallback
-- when a pair is uncached or the API is unavailable.
-- Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.road_distance_cache (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  from_key    text not null,   -- rounded "lat,lng" of the origin
  to_key      text not null,   -- rounded "lat,lng" of the destination
  km          numeric not null,
  seconds     integer,

  unique (user_id, from_key, to_key)
);

alter table public.road_distance_cache enable row level security;
create policy "road_distance_cache: select own" on public.road_distance_cache for select using (auth.uid() = user_id);
create policy "road_distance_cache: insert own" on public.road_distance_cache for insert with check (auth.uid() = user_id);
create policy "road_distance_cache: update own" on public.road_distance_cache for update using (auth.uid() = user_id);
create policy "road_distance_cache: delete own" on public.road_distance_cache for delete using (auth.uid() = user_id);

create index if not exists road_distance_cache_lookup_idx
  on public.road_distance_cache(user_id, from_key, to_key);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-13 — Schedule Health ignored issues. The
-- Schedule Health card flags duplicate / conflicting / overlapping
-- visits before they reach Day Ops; "Ignore intentionally" stores
-- the issue's stable key here so it stays dismissed across reloads.
-- Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.schedule_health_ignored (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  issue_key   text not null,   -- stable key, e.g. "dup|c:<cust>|mow|2026-06-26"
  unique (user_id, issue_key)
);

alter table public.schedule_health_ignored enable row level security;
create policy "schedule_health_ignored: select own" on public.schedule_health_ignored for select using (auth.uid() = user_id);
create policy "schedule_health_ignored: insert own" on public.schedule_health_ignored for insert with check (auth.uid() = user_id);
create policy "schedule_health_ignored: delete own" on public.schedule_health_ignored for delete using (auth.uid() = user_id);

create index if not exists schedule_health_ignored_user_idx
  on public.schedule_health_ignored(user_id);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-13 — Explicit initial (anchor) visit. The
-- FIRST visit of a recurring series is the "initial visit": it
-- derives the quote's INITIAL price, while every later visit
-- derives the cadence (weekly/biweekly/monthly) price. Modelled
-- as a flag so editing the recurring price can never overwrite it.
-- Existing rows default false (unchanged behaviour); new series
-- set it on their anchor. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
alter table public.jobs
  add column if not exists is_initial_visit boolean not null default false;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-13 — Job / property photos. Before-and-after
-- pictures captured while running a visit (Day Ops) and shown as a
-- visual service history on the property. Files live in the public
-- `job-photos` storage bucket under <user_id>/<property_id>/…; this
-- table is the catalogue (which photo belongs to which visit, its
-- before/after tag, optional caption). Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.job_photos (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- The visit the photo was taken on (null once a one-off job is deleted, but
  -- the photo stays attached to the property as service history).
  job_id       uuid references public.jobs(id) on delete set null,
  property_id  uuid references public.properties(id) on delete cascade,
  customer_id  uuid references public.customers(id) on delete set null,
  storage_path text not null,                 -- path within the job-photos bucket
  kind         text not null default 'after', -- 'before' | 'after' | 'general'
  caption      text,
  taken_at     timestamptz not null default now()
);

alter table public.job_photos enable row level security;
create policy "job_photos: select own" on public.job_photos for select using (auth.uid() = user_id);
create policy "job_photos: insert own" on public.job_photos for insert with check (auth.uid() = user_id);
create policy "job_photos: update own" on public.job_photos for update using (auth.uid() = user_id);
create policy "job_photos: delete own" on public.job_photos for delete using (auth.uid() = user_id);

create index if not exists job_photos_property_idx on public.job_photos(user_id, property_id);
create index if not exists job_photos_job_idx      on public.job_photos(user_id, job_id);

-- Public storage bucket for the image files. Public so PDFs / the gallery can
-- render them with a plain URL; writes are still owner-scoped by the policies
-- below (the first path segment must be the uploader's user id).
insert into storage.buckets (id, name, public)
  values ('job-photos', 'job-photos', true)
  on conflict (id) do nothing;

create policy "job-photos: read"        on storage.objects for select
  using (bucket_id = 'job-photos');
create policy "job-photos: insert own"  on storage.objects for insert
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "job-photos: update own"  on storage.objects for update
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "job-photos: delete own"  on storage.objects for delete
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-13 — Job add-ons, price history, invoice
-- breakdown. The JOB (base price + add-on services) is the single
-- source of truth for what a visit is worth; the invoice mirrors it.
--   • job_line_items  — extra services on a visit (Fertilizer $45…).
--                       Attached to concrete visit rows; "future /
--                       entire plan" inserts one row per affected
--                       non-completed visit sharing a group_id.
--   • job_price_changes — audit trail (old → new, reason on raises).
--   • invoices.line_items — snapshot breakdown for the customer.
-- All structured for later BI (frequent add-ons, upsells, avg
-- ticket, most-profitable add-ons). Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.job_line_items (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  job_id           uuid not null references public.jobs(id) on delete cascade,
  description      text not null,            -- "Fertilizer", "Weed Control", custom…
  amount           numeric not null default 0,
  -- Normalised key for BI grouping ("fertilizer", "weed_control", "custom").
  service_key      text,
  -- Lawn/snow/year_round bucket (lib/seasons serviceCategory), for analytics.
  service_category text,
  -- Batches the rows created by one "future / entire plan" apply, so the whole
  -- group can be edited or removed together.
  group_id         uuid,
  -- Informational: was this add-on applied across the plan (vs this visit only).
  recurring        boolean not null default false
);

alter table public.job_line_items enable row level security;
create policy "job_line_items: select own" on public.job_line_items for select using (auth.uid() = user_id);
create policy "job_line_items: insert own" on public.job_line_items for insert with check (auth.uid() = user_id);
create policy "job_line_items: update own" on public.job_line_items for update using (auth.uid() = user_id);
create policy "job_line_items: delete own" on public.job_line_items for delete using (auth.uid() = user_id);

create index if not exists job_line_items_job_idx   on public.job_line_items(user_id, job_id);
create index if not exists job_line_items_group_idx on public.job_line_items(group_id);

create table if not exists public.job_price_changes (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  -- Keep the audit row even if the visit is later deleted.
  job_id           uuid references public.jobs(id) on delete set null,
  -- Set when the change wrote to a quote's cadence price (recurring future/all).
  quote_id         uuid references public.quotes(id) on delete set null,
  scope            text,                     -- 'this' | 'future' | 'all' | null(one-time)
  old_amount       numeric,
  new_amount       numeric,
  reason           text,                     -- only required on a price INCREASE
  changed_by_email text
);

alter table public.job_price_changes enable row level security;
create policy "job_price_changes: select own" on public.job_price_changes for select using (auth.uid() = user_id);
create policy "job_price_changes: insert own" on public.job_price_changes for insert with check (auth.uid() = user_id);
create policy "job_price_changes: delete own" on public.job_price_changes for delete using (auth.uid() = user_id);

create index if not exists job_price_changes_job_idx on public.job_price_changes(user_id, job_id);

-- Snapshot of the invoice's line breakdown at the moment it was drafted/sent:
--   [{ "description": "Weekly Mowing", "amount": 65, "kind": "service" }, …]
-- Null/empty → render the legacy single (service_type, amount) row.
alter table public.invoices
  add column if not exists line_items jsonb;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-13 — Crew cost per hour. The fully-loaded cost
-- of one crew-hour (labour + overhead). THE single business cost
-- basis used to turn revenue into expected PROFIT everywhere:
-- the measure-business verdict, customer / route / area
-- profitability, suggestions, and quality scoring. Set once in
-- Settings → Business Basics; defaults to a sensible $40/hr.
-- Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists crew_cost_per_hour numeric default 40;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-14 — Target revenue per crew-hour. The owner's
-- minimum acceptable revenue/hour (on-site + drive). The Suggestions
-- Center uses it as a GUARDRAIL: customers / routes / areas earning
-- below it are flagged with a graduated fix (raise price → improve
-- route density → review) BEFORE ever suggesting a drop. Set in
-- Settings → Business Basics; defaults to $60/hr. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists target_rev_per_hour numeric default 60;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-14 — Customer Portal (magic link). A customer
-- opens /portal/<token> (no login). All reads/writes go through the
-- SECURITY DEFINER functions below, which return ONLY the data for
-- the token's customer — so the public anon role can never see
-- another customer's records. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.customer_portal_tokens (
  token       text primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  revoked     boolean not null default false
);
alter table public.customer_portal_tokens enable row level security;
-- Owner manages their own tokens; the PUBLIC read path is the function, not this table.
create policy "portal_tokens: select own" on public.customer_portal_tokens for select using (auth.uid() = user_id);
create policy "portal_tokens: insert own" on public.customer_portal_tokens for insert with check (auth.uid() = user_id);
create policy "portal_tokens: update own" on public.customer_portal_tokens for update using (auth.uid() = user_id);
create policy "portal_tokens: delete own" on public.customer_portal_tokens for delete using (auth.uid() = user_id);
create index if not exists portal_tokens_customer_idx on public.customer_portal_tokens(user_id, customer_id);

create table if not exists public.service_requests (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  message     text not null,
  status      text not null default 'new'      -- new | seen | done
);
alter table public.service_requests enable row level security;
create policy "service_requests: select own" on public.service_requests for select using (auth.uid() = user_id);
create policy "service_requests: update own" on public.service_requests for update using (auth.uid() = user_id);
create policy "service_requests: delete own" on public.service_requests for delete using (auth.uid() = user_id);
-- (inserts come ONLY from the portal RPC below — no anon insert policy on the table.)
create index if not exists service_requests_user_idx on public.service_requests(user_id, status);

-- Portal read: ONE function, returns ONLY the token's customer data.
create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code from public.customers where id = v_customer) c),
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, website, logo_url from public.business_settings where user_id = v_user) b),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, weekly_price, biweekly_price, monthly_price, notes, status, created_at from public.quotes where customer_id = v_customer and status in ('sent','accepted','declined')) q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, line_items, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'history', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, service_type, title, scheduled_date, status from public.jobs where customer_id = v_customer and status = 'completed') j), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- Accept a quote from the portal (scoped to the token's customer + a sent quote).
create or replace function public.portal_accept_quote(p_token text, p_quote_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.quotes set status = 'accepted' where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end; $$;
grant execute on function public.portal_accept_quote(text, uuid) to anon, authenticated;

-- Submit a service request from the portal.
create or replace function public.portal_request_service(p_token text, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  if coalesce(trim(p_message), '') = '' then return false; end if;
  insert into public.service_requests (user_id, customer_id, message) values (v_user, v_customer, left(p_message, 1000));
  return true;
end; $$;
grant execute on function public.portal_request_service(text, text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-14 — Communications (opt-in + send log).
-- ARCHITECTURE ONLY: sending stays DISABLED in lib/comms until
-- Twilio/Resend credentials are set in env. These tables let the
-- (disabled) send layer record consent + de-dupe sends. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.customers
  add column if not exists sms_opt_in   boolean not null default false,
  add column if not exists email_opt_in boolean not null default false;

create table if not exists public.notification_log (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  job_id      uuid references public.jobs(id) on delete set null,
  channel     text not null,                  -- 'sms' | 'email'
  template    text not null,                  -- 'reminder' | 'on_my_way' | 'job_complete' | 'review_request'
  status      text not null default 'sent',   -- 'sent' | 'failed' | 'disabled' | 'skipped'
  detail      text
);
alter table public.notification_log enable row level security;
create policy "notification_log: select own" on public.notification_log for select using (auth.uid() = user_id);
create policy "notification_log: insert own" on public.notification_log for insert with check (auth.uid() = user_id);
create index if not exists notification_log_dedupe_idx on public.notification_log(user_id, job_id, template);
