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
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    -- Show the customer every quote that has left the workshop — sent, accepted,
    -- declined, and (crucially) scheduled/completed/paid once it's been won and
    -- booked. Only internal DRAFTS are hidden. (Was status in (sent,accepted,
    -- declined), which made a won quote vanish from the portal the moment it was
    -- scheduled into a job.)
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, weekly_price, biweekly_price, monthly_price, notes, status, created_at from public.quotes where customer_id = v_customer and status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, line_items, job_id, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json)
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

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-21 — One-tap field messaging. Editable per-type
-- message templates + Google review link (both on business_settings,
-- so wording is customised without code), plus an "on my way" stamp
-- on jobs so the customer portal can show a live status. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists message_templates jsonb,   -- { on_my_way: "Hi {{first_name}}…", … } — owner overrides; engine has defaults
  add column if not exists review_url         text;   -- Google review link for {{review_link}}

alter table public.jobs
  add column if not exists on_my_way_at timestamptz;  -- set when the owner taps "On my way" → live portal status

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-21 — Automated message toggles. Which recurring
-- messages fire automatically. Per-customer opt-in STILL gates every
-- send, so null (= all on) can't message anyone who hasn't consented.
-- { reminder: bool, job_complete: bool, review: bool }. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists automations jsonb;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-21 — Suggestions Center dismiss / snooze.
-- The advisor feed stays trustworthy when the owner can clear a
-- decided card: a row here suppresses a suggestion by its stable
-- key. snooze_until null = dismissed indefinitely; a date = hidden
-- until that day (then it resurfaces if still relevant). Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.suggestion_dismissals (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  suggestion_key text not null,        -- Suggestion.id, e.g. "price-<rid>", "churn-<rid>", "median-<rid>"
  snooze_until   date,                 -- null = forever; else hidden until this date
  unique (user_id, suggestion_key)
);

alter table public.suggestion_dismissals enable row level security;
create policy "suggestion_dismissals: select own" on public.suggestion_dismissals for select using (auth.uid() = user_id);
create policy "suggestion_dismissals: insert own" on public.suggestion_dismissals for insert with check (auth.uid() = user_id);
create policy "suggestion_dismissals: update own" on public.suggestion_dismissals for update using (auth.uid() = user_id);
create policy "suggestion_dismissals: delete own" on public.suggestion_dismissals for delete using (auth.uid() = user_id);

create index if not exists suggestion_dismissals_user_idx
  on public.suggestion_dismissals(user_id);

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Stripe payments (Pay Now + webhook + history).
-- Hosted Stripe Checkout. Sending stays DISABLED until STRIPE_SECRET_KEY is set
-- (see lib/stripe). The webhook (service role) is the ONLY writer of a Stripe
-- 'paid'; the create-session routes never trust a client-sent amount — it's
-- built from the invoice row. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
alter table public.invoices add column if not exists paid_at timestamptz;

create table if not exists public.payments (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  customer_id           uuid references public.customers(id) on delete set null,
  invoice_id            uuid references public.invoices(id) on delete set null,
  amount                numeric not null default 0,
  currency              text not null default 'cad',
  provider              text not null default 'stripe',
  stripe_session_id     text unique,                    -- idempotency: one row per checkout session
  stripe_payment_intent text,
  status                text not null default 'paid',   -- pending | paid | failed | refunded
  paid_at               timestamptz
);
alter table public.payments enable row level security;
-- Owner reads their own payment history. Writes are done by the service-role
-- webhook (bypasses RLS) — there is deliberately NO anon/auth insert policy, so
-- nothing client-side can fabricate a payment.
create policy "payments: select own" on public.payments for select using (auth.uid() = user_id);
create index if not exists payments_user_idx    on public.payments(user_id, created_at desc);
create index if not exists payments_invoice_idx on public.payments(invoice_id);

-- Portal pay: returns a payable invoice ONLY if it belongs to the token's
-- customer and is still owing. Gives the (server-side) pay route the amount + ids
-- to build a Stripe Checkout session — the client never supplies an amount.
create or replace function public.portal_invoice_for_payment(p_token text, p_invoice_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; result json;
begin
  select customer_id into v_customer
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(i) into result from (
    select id, invoice_number, service_type, amount, status, customer_id, user_id
    from public.invoices
    where id = p_invoice_id and customer_id = v_customer and status in ('unpaid','sent')
  ) i;
  return result;
end; $$;
grant execute on function public.portal_invoice_for_payment(text, uuid) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Quote ↔ job/invoice lifecycle sync.
-- Lifecycle: Draft → Sent → Accepted → Scheduled → Completed → Paid (+ Declined).
-- Keeps a quote in step with the work it spawned WITHOUT completing a recurring
-- plan after a single visit. Centralised as DB triggers so EVERY path (Day Ops,
-- quick-save, Missed-jobs, manual mark-paid, the Stripe webhook) stays in sync —
-- nothing client-side can bypass it. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════

-- A ONE-TIME job tied to a quote completes → quote advances to 'completed'.
-- Recurring visits (recurrence_id set) NEVER complete the quote: the plan is
-- ongoing, so it stays 'scheduled'. Only advances from an in-flight status, so a
-- re-complete or an already-paid quote is never moved backwards.
create or replace function public.sync_quote_on_job_complete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
     and new.quote_id is not null and new.recurrence_id is null then
    update public.quotes set status = 'completed'
      where id = new.quote_id and status in ('accepted','scheduled');
  end if;
  return new;
end; $$;
drop trigger if exists trg_sync_quote_on_job_complete on public.jobs;
create trigger trg_sync_quote_on_job_complete after update of status on public.jobs
  for each row execute function public.sync_quote_on_job_complete();

-- A ONE-TIME quote's invoice is paid → quote advances to 'paid'. Guarded to
-- quotes already 'completed' (one-time), so paying one visit of a recurring plan
-- never marks the whole plan paid.
create or replace function public.sync_quote_on_invoice_paid()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.quote_id is not null then
    update public.quotes set status = 'paid'
      where id = new.quote_id and status = 'completed';
  end if;
  return new;
end; $$;
drop trigger if exists trg_sync_quote_on_invoice_paid on public.invoices;
create trigger trg_sync_quote_on_invoice_paid after update of status on public.invoices
  for each row execute function public.sync_quote_on_invoice_paid();

-- One-time backfill for quotes that desynced BEFORE these triggers existed:
-- a one-time quote whose job is already completed → 'completed'; then those whose
-- invoice is already paid → 'paid'. Recurring quotes (any recurring job) are left
-- untouched.
update public.quotes q set status = 'completed'
where q.status in ('accepted','scheduled')
  and exists (select 1 from public.jobs j  where j.quote_id = q.id and j.status = 'completed' and j.recurrence_id is null)
  and not exists (select 1 from public.jobs j2 where j2.quote_id = q.id and j2.recurrence_id is not null);

update public.quotes q set status = 'paid'
where q.status = 'completed'
  and exists (select 1 from public.invoices i where i.quote_id = q.id and i.status = 'paid');

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-22 — Win/Loss analysis (GROWTH). Records WHY a
-- quote was lost (and an optional competitor price) so the Suggestions
-- Center can feed pricing intelligence — e.g. "you keep losing on
-- price in Queensland". Captured from the Grow → Win/Loss panel
-- (read-only over quotes; never modifies the quotes flow). The win
-- side is derived from quotes.status; this table only stores the
-- loss reason. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════
create table if not exists public.quote_outcomes (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  quote_id         uuid not null references public.quotes(id) on delete cascade,
  reason           text not null,   -- price | competitor | no_response | timing | scope | not_needed | other
  detail           text,
  competitor_price numeric,
  unique (user_id, quote_id)
);

alter table public.quote_outcomes enable row level security;
create policy "quote_outcomes: select own" on public.quote_outcomes for select using (auth.uid() = user_id);
create policy "quote_outcomes: insert own" on public.quote_outcomes for insert with check (auth.uid() = user_id);
create policy "quote_outcomes: update own" on public.quote_outcomes for update using (auth.uid() = user_id);
create policy "quote_outcomes: delete own" on public.quote_outcomes for delete using (auth.uid() = user_id);

create index if not exists quote_outcomes_user_idx on public.quote_outcomes(user_id);

-- ── Hardening (2026-06-23): corrective re-sync when a job becomes recurring ──
-- Defends the "a recurring plan is never completed by one visit" invariant against
-- client write-ordering: convert-to-recurring writes the anchor's status BEFORE
-- it sets recurrence_id, so the job-complete trigger can momentarily mark a quote
-- 'completed' while recurrence_id is still NULL. The instant the anchor gains a
-- recurrence_id, pull the quote back to 'scheduled' (an ongoing plan), undoing
-- any premature completed/paid. Independent of client ordering — DB-enforced.
create or replace function public.resync_quote_on_job_recurring()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.recurrence_id is not null and old.recurrence_id is null and new.quote_id is not null then
    update public.quotes set status = 'scheduled'
      where id = new.quote_id and status in ('completed','paid');
  end if;
  return new;
end; $$;
drop trigger if exists trg_resync_quote_on_job_recurring on public.jobs;
create trigger trg_resync_quote_on_job_recurring after update of recurrence_id on public.jobs
  for each row execute function public.resync_quote_on_job_recurring();

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Payment fee recovery + GST + payment method.
-- Strategy: recover Stripe cost via a GLOBAL PRICE INCREASE baked into NEW quotes
-- (NOT a card surcharge — Calgary/Alberta-compliant, no surcharge rules, no
-- separate fee line shown to the customer). GST is a pass-through, computed on top
-- at display/charge time, shown only when gst_percent > 0. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists payment_fee_strategy       text    not null default 'global_price_increase',
  add column if not exists fee_recovery_percent       numeric not null default 3,
  add column if not exists etransfer_discount_percent numeric not null default 0,
  add column if not exists gst_percent                numeric not null default 0;
alter table public.business_settings drop constraint if exists business_settings_fee_strategy_chk;
alter table public.business_settings add constraint business_settings_fee_strategy_chk
  check (payment_fee_strategy in ('absorb','global_price_increase','etransfer_discount'));

alter table public.invoices add column if not exists payment_method text;
alter table public.invoices drop constraint if exists invoices_payment_method_chk;
alter table public.invoices add constraint invoices_payment_method_chk
  check (payment_method is null or payment_method in ('stripe','etransfer','cash','cheque'));

-- Portal pay needs the owner's GST rate to charge the GST-inclusive total.
create or replace function public.portal_invoice_for_payment(p_token text, p_invoice_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; result json;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(i) into result from (
    select inv.id, inv.invoice_number, inv.service_type, inv.amount, inv.status, inv.customer_id, inv.user_id,
           coalesce(bs.gst_percent, 0) as gst_percent
    from public.invoices inv
    left join public.business_settings bs on bs.user_id = inv.user_id
    where inv.id = p_invoice_id and inv.customer_id = v_customer and inv.status in ('unpaid','sent')
  ) i;
  return result;
end; $$;
grant execute on function public.portal_invoice_for_payment(text, uuid) to anon, authenticated;

-- Portal display needs gst_percent in the business object to show Subtotal/GST/Total.
create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code from public.customers where id = v_customer) c),
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, website, logo_url, coalesce(gst_percent,0) as gst_percent from public.business_settings where user_id = v_user) b),
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, weekly_price, biweekly_price, monthly_price, notes, status, created_at from public.quotes where customer_id = v_customer and status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, line_items, job_id, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Communication consent: bulk tools + audit trail.
-- consent_changes logs WHO changed a customer's SMS/email consent, WHEN, and the
-- old→new value, from any source (single edit, bulk action, portal self-serve,
-- import). Customers never auto-opt-in. Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.consent_changes (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,  -- audit survives a customer delete
  channel     text not null,        -- 'sms' | 'email'
  old_value   boolean,
  new_value   boolean,
  source      text not null,        -- 'single' | 'bulk' | 'portal' | 'import'
  changed_by  text                  -- owner email, or 'customer (portal)'
);
alter table public.consent_changes enable row level security;
drop policy if exists "consent_changes: select own" on public.consent_changes;
create policy "consent_changes: select own" on public.consent_changes for select using (auth.uid() = user_id);
drop policy if exists "consent_changes: insert own" on public.consent_changes;
create policy "consent_changes: insert own" on public.consent_changes for insert with check (auth.uid() = user_id);
create index if not exists consent_changes_cust_idx on public.consent_changes(user_id, customer_id, created_at desc);

-- Portal self-serve consent: token-scoped update + audit (SECURITY DEFINER, so the
-- anon portal can write its own customer's consent without broad table grants).
create or replace function public.portal_set_consent(p_token text, p_sms_opt_in boolean, p_email_opt_in boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; v_old_sms boolean; v_old_email boolean;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  select sms_opt_in, email_opt_in into v_old_sms, v_old_email from public.customers where id = v_customer;
  update public.customers set sms_opt_in = p_sms_opt_in, email_opt_in = p_email_opt_in where id = v_customer;
  if v_old_sms is distinct from p_sms_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
      values (v_user, v_customer, 'sms', v_old_sms, p_sms_opt_in, 'portal', 'customer (portal)');
  end if;
  if v_old_email is distinct from p_email_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
      values (v_user, v_customer, 'email', v_old_email, p_email_opt_in, 'portal', 'customer (portal)');
  end if;
  return true;
end; $$;
grant execute on function public.portal_set_consent(text, boolean, boolean) to anon, authenticated;

-- get_portal_data: expose sms_opt_in/email_opt_in so the portal can show + edit consent.
create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in from public.customers where id = v_customer) c),
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, website, logo_url, coalesce(gst_percent,0) as gst_percent from public.business_settings where user_id = v_user) b),
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, weekly_price, biweekly_price, monthly_price, notes, status, created_at from public.quotes where customer_id = v_customer and status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, line_items, job_id, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Instant-Quote + Online Booking funnel.
-- A public, token-keyed page (/book/<booking_token>) lets a prospect get an
-- instant price from the owner's pricing engine and book — creating a customer +
-- property + quote and notifying the owner. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.business_settings
  add column if not exists booking_enabled boolean not null default false,
  add column if not exists booking_token   text;

-- Public: branding + pricing config for the booking page (only when enabled).
create or replace function public.get_booking_business(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare result json;
begin
  select to_json(b) into result from (
    select company_name, owner_name, logo_url, phone, email_primary, website,
           pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate,
           payment_fee_strategy, fee_recovery_percent, gst_percent
    from public.business_settings
    where booking_token = p_token and booking_enabled = true
  ) b;
  return result;  -- null when the token is invalid or booking is disabled
end; $$;
grant execute on function public.get_booking_business(text) to anon, authenticated;

-- Public: turn a self-serve booking into a customer + property + 'sent' quote,
-- and drop a service_request so the owner sees the new lead. Prices already
-- include the owner's fee-recovery markup (computed client-side). Token-scoped.
create or replace function public.submit_booking(
  p_token text, p_name text, p_email text, p_phone text,
  p_address text, p_city text, p_province text, p_postal text,
  p_lat double precision, p_lng double precision, p_sqft numeric,
  p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric,
  p_cadence text
) returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(trim(p_name), '') = '' then return null; end if;

  insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source)
    values (v_user, left(p_name, 200), nullif(trim(p_email), ''), nullif(trim(p_phone), ''), p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, 'Online Booking')
    returning id into v_customer;

  insert into public.properties (user_id, customer_id, address, city, province, postal_code, lat, lng, lawn_sqft, is_primary)
    values (v_user, v_customer, p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, p_lat, p_lng, nullif(p_sqft, 0), true)
    returning id into v_property;

  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
    from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, sent_at)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, coalesce(nullif(p_service_type, ''), 'Lawn Mowing'),
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'sent', nullif(p_sqft, 0), v_property, now())
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time') || ' · quote ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $$;
grant execute on function public.submit_booking(text, text, text, text, text, text, text, text, double precision, double precision, numeric, text, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23b — Booking funnel: lead quality + review-first.
-- Bookings now land as a DRAFT quote (owner reviews/approves before scheduling —
-- the funnel still never creates a job). Adds optional notes, photos, "how heard",
-- referral code, and UTM attribution. Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.quotes add column if not exists lead_meta jsonb;

-- Public upload bucket for booking photos (anon insert, public read). If your
-- project restricts storage DDL via SQL, create the bucket + these two policies
-- in the Storage dashboard instead — the funnel degrades gracefully without it.
insert into storage.buckets (id, name, public) values ('booking-uploads', 'booking-uploads', true)
  on conflict (id) do nothing;
drop policy if exists "booking_uploads_anon_insert" on storage.objects;
create policy "booking_uploads_anon_insert" on storage.objects for insert to anon with check (bucket_id = 'booking-uploads');
drop policy if exists "booking_uploads_public_read" on storage.objects;
create policy "booking_uploads_public_read" on storage.objects for select to anon, authenticated using (bucket_id = 'booking-uploads');

-- Replace submit_booking: DRAFT quote + lead metadata + attribution.
drop function if exists public.submit_booking(text, text, text, text, text, text, text, text, double precision, double precision, numeric, text, numeric, numeric, numeric, numeric, text);
create or replace function public.submit_booking(
  p_token text, p_name text, p_email text, p_phone text,
  p_address text, p_city text, p_province text, p_postal text,
  p_lat double precision, p_lng double precision, p_sqft numeric,
  p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric,
  p_cadence text,
  p_notes text default null, p_hear_about text default null, p_referral_code text default null,
  p_utm jsonb default null, p_photos text[] default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
        v_source text; v_meta jsonb; v_photo_count int := coalesce(array_length(p_photos, 1), 0);
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(trim(p_name), '') = '' then return null; end if;

  -- Acquisition source: prefer the customer's stated answer, else the UTM source.
  v_source := coalesce(nullif(trim(p_hear_about), ''), nullif(p_utm->>'source', ''), 'Online Booking');
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'hear_about', p_hear_about, 'referral_code', p_referral_code, 'utm', p_utm,
    'photos', to_jsonb(p_photos), 'additional_notes', p_notes));

  insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source, notes)
    values (v_user, left(p_name, 200), nullif(trim(p_email), ''), nullif(trim(p_phone), ''), p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, v_source, nullif(trim(p_notes), ''))
    returning id into v_customer;

  insert into public.properties (user_id, customer_id, address, city, province, postal_code, lat, lng, lawn_sqft, is_primary)
    values (v_user, v_customer, p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, p_lat, p_lng, nullif(p_sqft, 0), true)
    returning id into v_property;

  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
    from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  -- DRAFT — appears in "Drafts to review"; the owner approves, then schedules.
  insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, notes, lead_meta)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, coalesce(nullif(p_service_type, ''), 'Lawn Mowing'),
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'draft', nullif(p_sqft, 0), v_property, nullif(trim(p_notes), ''), v_meta)
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking (review) — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time')
      || ' · via ' || v_source || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || case when nullif(trim(p_referral_code), '') is not null then ' · ref:' || p_referral_code else '' end || ' · draft ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $$;
grant execute on function public.submit_booking(text, text, text, text, text, text, text, text, double precision, double precision, numeric, text, numeric, numeric, numeric, numeric, text, text, text, text, jsonb, text[]) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Auto-measure: measurement store + learning + analytics.
-- Records the AUTO estimate vs the FINAL accepted area for every measurement so
-- the estimate self-calibrates per neighborhood and we can report accuracy. The
-- provider that produced the estimate is stored (source) so a paid provider can
-- be swapped in later while keeping all history/analytics. Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.measurements (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  property_id   uuid references public.properties(id) on delete set null,
  quote_id      uuid references public.quotes(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  lat           double precision,
  lng           double precision,
  neighborhood  text,
  context       text,            -- 'quote' | 'property' | 'booking' | 'snow'
  source        text,            -- provider: 'calgary-buildings' | 'manual' | 'satquote' …
  confidence    text,            -- 'high' | 'medium' | 'low'
  building_sqft numeric,         -- footprint the estimate was anchored on
  auto_sqft     numeric,         -- the provider's auto estimate (null = pure manual)
  accepted_sqft numeric,         -- the final accepted/measured area
  adjusted      boolean,         -- accepted materially != auto
  diff_pct      numeric          -- (accepted − auto) / auto × 100
);
alter table public.measurements enable row level security;
drop policy if exists "measurements: select own" on public.measurements;
create policy "measurements: select own" on public.measurements for select using (auth.uid() = user_id);
drop policy if exists "measurements: insert own" on public.measurements;
create policy "measurements: insert own" on public.measurements for insert with check (auth.uid() = user_id);
create index if not exists measurements_user_idx on public.measurements(user_id, created_at desc);
create index if not exists measurements_hood_idx on public.measurements(user_id, neighborhood);

-- Anon booking funnel records its measurement via this token-scoped writer
-- (the owner's authenticated surfaces insert directly under RLS).
create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision, p_neighborhood text,
  p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;
  insert into public.measurements (user_id, quote_id, lat, lng, neighborhood, context, source, confidence,
      building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, p_lat, p_lng, nullif(p_neighborhood, ''), 'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end; $$;
grant execute on function public.record_booking_measurement(text, uuid, double precision, double precision, text, numeric, numeric, numeric, text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Two-way SMS conversations (unified inbox).
-- ONE conversation per customer, ONE messages timeline across SMS / portal /
-- internal notes; templated sends stay in notification_log and merge into the
-- thread at read-time. The inbound Twilio webhook (service role) writes here.
-- Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.conversations (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  last_message_at timestamptz not null default now(),
  last_preview    text,
  last_direction  text,                       -- 'inbound' | 'outbound' | 'internal'
  unread          int not null default 0,     -- owner's unread inbound count
  unique (user_id, customer_id)
);
alter table public.conversations enable row level security;
drop policy if exists "conversations: select own" on public.conversations;
create policy "conversations: select own" on public.conversations for select using (auth.uid() = user_id);
drop policy if exists "conversations: insert own" on public.conversations;
create policy "conversations: insert own" on public.conversations for insert with check (auth.uid() = user_id);
drop policy if exists "conversations: update own" on public.conversations;
create policy "conversations: update own" on public.conversations for update using (auth.uid() = user_id);
create index if not exists conversations_user_idx on public.conversations(user_id, last_message_at desc);

create table if not exists public.messages (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  customer_id     uuid references public.customers(id) on delete set null,
  direction       text not null,              -- 'inbound' | 'outbound' | 'internal'
  channel         text not null default 'sms',-- 'sms' | 'email' | 'portal' | 'internal'
  body            text not null,
  twilio_sid      text,
  status          text,
  meta            jsonb
);
alter table public.messages enable row level security;
drop policy if exists "messages: select own" on public.messages;
create policy "messages: select own" on public.messages for select using (auth.uid() = user_id);
drop policy if exists "messages: insert own" on public.messages;
create policy "messages: insert own" on public.messages for insert with check (auth.uid() = user_id);
create index if not exists messages_convo_idx on public.messages(conversation_id, created_at);

-- Keep the conversation summary + owner unread in sync on every message.
create or replace function public.bump_conversation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = new.created_at,
    last_preview = left(new.body, 140),
    last_direction = new.direction,
    unread = case when new.direction = 'inbound' then unread + 1 else unread end
  where id = new.conversation_id;
  return new;
end; $$;
drop trigger if exists trg_bump_conversation on public.messages;
create trigger trg_bump_conversation after insert on public.messages
  for each row execute function public.bump_conversation();

-- Match a customer by phone (last 10 digits) for the inbound webhook.
create or replace function public.find_customer_by_phone(p_phone text)
returns json language plpgsql security definer set search_path = public as $$
declare d text; result json;
begin
  d := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(d) < 10 then return null; end if;
  select to_json(c) into result from (
    select id, user_id, sms_opt_in, name from public.customers
    where phone is not null and right(regexp_replace(phone, '\D', '', 'g'), 10) = d
    order by created_at desc limit 1
  ) c;
  return result;
end; $$;
grant execute on function public.find_customer_by_phone(text) to authenticated, service_role;

-- Portal service requests flow into the SAME thread (channel 'portal').
create or replace function public.sr_to_conversation() returns trigger language plpgsql security definer set search_path = public as $$
declare v_convo uuid;
begin
  if new.customer_id is null then return new; end if;
  select id into v_convo from public.conversations where user_id = new.user_id and customer_id = new.customer_id;
  if v_convo is null then
    insert into public.conversations (user_id, customer_id, last_message_at) values (new.user_id, new.customer_id, new.created_at) returning id into v_convo;
  end if;
  insert into public.messages (user_id, conversation_id, customer_id, direction, channel, body, status, meta, created_at)
    values (new.user_id, v_convo, new.customer_id, 'inbound', 'portal', new.message, 'received', jsonb_build_object('service_request_id', new.id), new.created_at);
  return new;
end; $$;
drop trigger if exists trg_sr_to_conversation on public.service_requests;
create trigger trg_sr_to_conversation after insert on public.service_requests
  for each row execute function public.sr_to_conversation();

-- One-time backfill of existing portal requests into conversations/messages.
do $$ begin
  if not exists (select 1 from public.conversations) then
    insert into public.conversations (user_id, customer_id, last_message_at, last_preview, last_direction, unread)
      select user_id, customer_id, max(created_at), 'Portal request', 'inbound', 0
      from public.service_requests where customer_id is not null
      group by user_id, customer_id on conflict (user_id, customer_id) do nothing;
    insert into public.messages (user_id, conversation_id, customer_id, direction, channel, body, status, meta, created_at)
      select sr.user_id, c.id, sr.customer_id, 'inbound', 'portal', sr.message, 'received', jsonb_build_object('service_request_id', sr.id), sr.created_at
      from public.service_requests sr join public.conversations c on c.user_id = sr.user_id and c.customer_id = sr.customer_id
      where sr.customer_id is not null;
    -- bump_conversation() counts each historical inbound row as unread. These are
    -- pre-existing requests, not new mail — clear the counter so the freshly
    -- backfilled inbox doesn't open with large false unread badges. Safe because
    -- this runs only on the first apply (guarded by the empty-table check above).
    update public.conversations set unread = 0;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Revenue Intelligence feedback loop (GROWTH).
-- Closes the loop on predictive recommendations: records what the owner
-- DID with each opportunity (acted / dismissed / won / lost) and the
-- realised result, so the ranking can learn which plays produce revenue.
-- One row per opportunity (kind + customer); upsert on the stable key.
-- Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.revenue_recommendations (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  opportunity_key text not null,        -- `${kind}:${customer_id}` — stable
  kind            text not null,        -- renewal | upsell | cross_sell | membership | referral
  customer_id     uuid references public.customers(id) on delete cascade,
  expected_value  numeric,
  status          text not null default 'acted',  -- acted | dismissed | won | lost
  result_value    numeric,              -- realised revenue when status = won
  acted_at        timestamptz,
  unique (user_id, opportunity_key)
);

alter table public.revenue_recommendations enable row level security;
create policy "revenue_recommendations: select own" on public.revenue_recommendations for select using (auth.uid() = user_id);
create policy "revenue_recommendations: insert own" on public.revenue_recommendations for insert with check (auth.uid() = user_id);
create policy "revenue_recommendations: update own" on public.revenue_recommendations for update using (auth.uid() = user_id);
create policy "revenue_recommendations: delete own" on public.revenue_recommendations for delete using (auth.uid() = user_id);

create index if not exists revenue_recommendations_user_idx on public.revenue_recommendations(user_id);

grant select, insert, update, delete on public.revenue_recommendations to authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Portal PDF downloads (COMMS/PORTAL).
-- The portal renders the SAME quote/invoice PDFs as the dashboard. Expose the
-- extra fields those documents print (quote crew/hours/travel/subtotal/issued;
-- invoice notes/address; business terms/base_address/email_secondary/logo_scale)
-- so the customer-facing PDF is identical. Still token-scoped: only this token's
-- customer's records are ever returned.
create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in from public.customers where id = v_customer) c),
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, email_secondary, website, logo_url, logo_scale, base_address, terms_text, coalesce(gst_percent,0) as gst_percent from public.business_settings where user_id = v_user) b),
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, subtotal, weekly_price, biweekly_price, monthly_price, notes, status, created_at, issued_date, crew_size, hours, travel_fee from public.quotes where customer_id = v_customer and status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, notes, address, line_items, job_id, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Smart Labor Calculator V2 (labor learning).
-- Learns true on-site durations from completed jobs to auto-estimate labor with
-- a confidence range — property-level history first, then service/sqft/season/
-- crew. BACKWARDS COMPATIBLE: feeds the labor/duration layer ONLY; pricing logic
-- is untouched. Captured via a DB trigger so no scheduling code changes. Idempotent.
-- ════════════════════════════════════════════════════════════

-- (a) Per-owner default for the "Use Smart Estimate" toggle.
alter table public.business_settings
  add column if not exists smart_labor_enabled boolean not null default true;

-- (b) Training store — one observation per completed, timed job.
create table if not exists public.labor_observations (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  job_id            uuid references public.jobs(id) on delete set null,
  property_id       uuid references public.properties(id) on delete set null,
  service_date      date,
  sqft              numeric,
  service_type      text,
  crew_size         integer not null default 1,
  frequency         text,
  is_initial_visit  boolean not null default false,
  overgrowth        numeric,
  estimated_minutes integer,
  actual_minutes    integer not null,
  unique (user_id, job_id)
);
alter table public.labor_observations enable row level security;
create policy "labor_observations: select own" on public.labor_observations for select using (auth.uid() = user_id);
create policy "labor_observations: insert own" on public.labor_observations for insert with check (auth.uid() = user_id);
create policy "labor_observations: update own" on public.labor_observations for update using (auth.uid() = user_id);
create policy "labor_observations: delete own" on public.labor_observations for delete using (auth.uid() = user_id);
create index if not exists labor_observations_user_idx on public.labor_observations(user_id);
create index if not exists labor_observations_prop_idx on public.labor_observations(user_id, property_id);
grant select, insert, update, delete on public.labor_observations to authenticated;

-- (c) Auto-capture on check-out (actual_minutes set) — DB-side, no app changes.
create or replace function public.capture_labor_observation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sqft numeric; v_overgrowth numeric; v_freq text;
begin
  if new.actual_minutes is not null and new.actual_minutes > 0
     and (old.actual_minutes is distinct from new.actual_minutes) then
    select p.lawn_sqft into v_sqft from public.properties p where p.id = new.property_id;
    select q.overgrowth_multiplier into v_overgrowth from public.quotes q where q.id = new.quote_id;
    select r.freq into v_freq from public.job_recurrences r where r.id = new.recurrence_id;
    insert into public.labor_observations
      (user_id, job_id, property_id, service_date, sqft, service_type, crew_size, frequency, is_initial_visit, overgrowth, estimated_minutes, actual_minutes)
    values
      (new.user_id, new.id, new.property_id, new.scheduled_date, v_sqft, new.service_type, coalesce(new.crew_size,1), v_freq, coalesce(new.is_initial_visit,false), v_overgrowth, new.duration_minutes, new.actual_minutes)
    on conflict (user_id, job_id) do update set
      actual_minutes = excluded.actual_minutes, estimated_minutes = excluded.estimated_minutes,
      sqft = excluded.sqft, crew_size = excluded.crew_size, overgrowth = excluded.overgrowth,
      frequency = excluded.frequency, is_initial_visit = excluded.is_initial_visit,
      service_date = excluded.service_date, created_at = now();
  end if;
  return new;
end; $$;
drop trigger if exists trg_capture_labor on public.jobs;
create trigger trg_capture_labor after update of actual_minutes on public.jobs
  for each row execute function public.capture_labor_observation();

-- (d) Backfill from existing completed timed jobs (idempotent via unique key).
insert into public.labor_observations
  (user_id, job_id, property_id, service_date, sqft, service_type, crew_size, frequency, is_initial_visit, overgrowth, estimated_minutes, actual_minutes)
select j.user_id, j.id, j.property_id, j.scheduled_date, p.lawn_sqft, j.service_type, coalesce(j.crew_size,1),
       r.freq, coalesce(j.is_initial_visit,false), q.overgrowth_multiplier, j.duration_minutes, j.actual_minutes
from public.jobs j
left join public.properties p on p.id = j.property_id
left join public.quotes q on q.id = j.quote_id
left join public.job_recurrences r on r.id = j.recurrence_id
where j.actual_minutes is not null and j.actual_minutes > 0
on conflict (user_id, job_id) do nothing;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-23 — Realtime for the unified inbox (COMMS).
-- Streams new inbound SMS + conversation bumps to the Messages page with no
-- refresh. RLS still applies — Realtime only delivers rows the subscribed owner
-- can SELECT (auth.uid() = user_id). Idempotent.
-- ════════════════════════════════════════════════════════════
alter table public.conversations replica identity full;
alter table public.messages replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations') then
      execute 'alter publication supabase_realtime add table public.conversations';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
      execute 'alter publication supabase_realtime add table public.messages';
    end if;
  end if;
end $$;
