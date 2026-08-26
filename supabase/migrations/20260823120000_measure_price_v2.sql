-- ── Measure & Price V2 — measurement + commercial offerings ──────────────────
-- Session 107.
--
-- WHAT THE PRICE BOOK COULD ALREADY DO, AND WHAT IT COULD NOT.
-- service_templates already carried `pricing_display_type = 'per_sqft'` and a
-- `default_rate`, and lib/servicePricing already multiplied one by a measured
-- area. That IS area pricing, and it is not rebuilt here.
--
-- What the table could not express is a service sold SEVERAL WAYS at once. It
-- has exactly one rate and one display type, so "Snow Removal: $0.08/sq ft
-- one-time, $249/month, $899/season" had nowhere to live. That is the whole gap
-- this migration closes, and it closes it with one column and one table.
--
-- ⛔ NOT A SECOND PRICING ENGINE and not a second Service Catalog. A plan row
-- belongs to a service_templates row; the catalogue is still the catalogue.
--
-- ⛔ NO SEASON DATES HERE. "Seasonal" is a commercial term; when a season needs
-- start/end dates the business already has them, owner-configured, in
-- business_settings.service_seasons (lib/seasons). Adding a second definition
-- would create two answers to "when does winter end", and the existing one is
-- already what scheduling and reactivation obey. Nothing in this migration
-- hardcodes a date.

-- ── 1. How a service is measured ─────────────────────────────────────────────
-- NULL = the owner has not said. lib/measurePricing then falls back to reading
-- the pricing display type (per_sqft ⇒ area, per_linear_ft ⇒ length), which is
-- what those words have always meant — so every service already configured keeps
-- working with nothing to migrate. The explicit column exists because the
-- display type cannot express "measured by area, sold as a flat monthly plan",
-- which is precisely the snow case.
alter table public."service_templates"
  add column if not exists "measured_by" text;

do $$ begin
  alter table public."service_templates"
    add constraint "service_templates_measured_by_check"
    check (("measured_by" is null or "measured_by" = any (array['area'::text, 'length'::text, 'count'::text])));
exception when duplicate_object then null; end $$;

comment on column public."service_templates"."measured_by" is
  'How this service is measured on the map: area | length | count. NULL = not stated; lib/measurePricing falls back to pricing_display_type. NULL is also how a service says "not measured" in practice — Measure & Price is not offered for it.';

-- ── 2. The ways a service is sold ────────────────────────────────────────────
-- ⭐ THE ROW EXISTING IS THE OFFER. There is no is_enabled column: an owner who
-- does not sell snow weekly simply has no weekly row, and a flag that can be
-- false while the row still exists is one UPDATE away from quoting a plan the
-- business withdrew. Same discipline as the rest of this codebase — the column
-- (or here, the row) IS the answer.
create table if not exists public."service_pricing_plans" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "user_id" uuid not null,
  "service_template_id" uuid not null,
  -- The COMMERCIAL term — how the customer buys. ⛔⛔ NOT a visit schedule.
  -- 'monthly' does not mean four visits a month; a seasonal snow contract might
  -- be eight visits or twenty-two. Operational recurrence stays in
  -- job_recurrences and is neither read nor written from here.
  "term" text not null,
  -- per_unit: price = rate × the measurement.  flat: price = rate.
  "basis" text not null,
  -- $/unit when per_unit, $ when flat.
  "rate" numeric(10,2) not null,
  "is_recommended" boolean default false not null,
  "sort_order" integer default 0 not null
);

do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_pkey" primary key ("id");
exception when duplicate_table or invalid_table_definition then null; end $$;

do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_term_check"
    check ("term" = any (array['one_time'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text, 'seasonal'::text]));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_basis_check"
    check ("basis" = any (array['per_unit'::text, 'flat'::text]));
exception when duplicate_object then null; end $$;

-- A negative price is not a discount, it is a data error. Zero is permitted at
-- the DB level and read as UNCONFIGURED by lib/measurePricing (an unknown price
-- is not $0) — the constraint refuses only what can never be meant.
do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_rate_check"
    check ("rate" >= 0);
exception when duplicate_object then null; end $$;

-- One plan per term per service: two "Monthly" rows would be a choice between
-- two prices for the same words, and nothing could pick between them.
do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_service_term_uk"
    unique ("service_template_id", "term");
exception when duplicate_object then null; end $$;

-- ⭐ THE TENANT WELD. A COMPOSITE foreign key, not a plain one: it makes the
-- plan's user_id and the template's user_id the same fact at the database level,
-- so a plan can never be attached to another tenant's service — not by a bug, not
-- by a crafted request, not by a DEFINER function that forgot to check. This is
-- the pattern service_bundle_items already uses against the same table.
do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_template_same_owner"
    foreign key ("service_template_id", "user_id")
    references public."service_templates" ("id", "user_id") on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public."service_pricing_plans" add constraint "service_pricing_plans_user_id_fkey"
    foreign key ("user_id") references auth.users ("id") on delete cascade;
exception when duplicate_object then null; end $$;

-- At most one recommended plan per service. Two "Recommended" badges is not a
-- recommendation, and quote_options enforces the same rule for the same reason.
create unique index if not exists "service_pricing_plans_one_recommended"
  on public."service_pricing_plans" using btree ("service_template_id")
  where "is_recommended";

create index if not exists "service_pricing_plans_user_idx"
  on public."service_pricing_plans" using btree ("user_id");
create index if not exists "service_pricing_plans_template_idx"
  on public."service_pricing_plans" using btree ("service_template_id", "sort_order");

drop trigger if exists "service_pricing_plans_updated_at" on public."service_pricing_plans";
create trigger "service_pricing_plans_updated_at" before update on public."service_pricing_plans"
  for each row execute function public.handle_updated_at();

alter table public."service_pricing_plans" enable row level security;

drop policy if exists "pricing plans: select own" on public."service_pricing_plans";
create policy "pricing plans: select own" on public."service_pricing_plans" as permissive for select to public
  using ((auth.uid() = user_id));
drop policy if exists "pricing plans: insert own" on public."service_pricing_plans";
create policy "pricing plans: insert own" on public."service_pricing_plans" as permissive for insert to public
  with check ((auth.uid() = user_id));
drop policy if exists "pricing plans: update own" on public."service_pricing_plans";
create policy "pricing plans: update own" on public."service_pricing_plans" as permissive for update to public
  using ((auth.uid() = user_id));
drop policy if exists "pricing plans: delete own" on public."service_pricing_plans";
create policy "pricing plans: delete own" on public."service_pricing_plans" as permissive for delete to public
  using ((auth.uid() = user_id));

-- ⚠️ Supabase grants a new table FULL DML to anon by default AT CREATE TIME, and
-- RLS is the only thing standing between that and the open internet. Crew
-- Communications V1 found exactly this. Revoke from everyone first, then grant
-- back only the two roles that may touch it — anon is never one of them: a price
-- book is not public.
revoke all on table public."service_pricing_plans" from public, anon, authenticated, service_role;
grant ALL on table public."service_pricing_plans" to authenticated;
grant ALL on table public."service_pricing_plans" to service_role;

comment on table public."service_pricing_plans" is
  'The ways one service is sold: a commercial term (one_time/weekly/biweekly/monthly/seasonal) with a rule for turning a measurement into money (per_unit rate x measurement, or flat). The ROW EXISTING is the offer. NOT a visit schedule — operational recurrence lives in job_recurrences.';

-- ── 3. What an issued quote remembers ────────────────────────────────────────
-- ⭐ THE FREEZE. Everything needed to reprint what was agreed is COPIED here at
-- the moment the owner uses a measurement, and never re-derived on read: the
-- total, the unit, each traced piece, the term, the basis and the rate as they
-- were that day. An owner who raises $0.08/sq ft to $0.11 next winter therefore
-- cannot silently rewrite a quote the customer already accepted.
--
-- Same pattern job_forms uses for checklist labels (Session 69): live
-- configuration is for the NEXT quote; an issued one carries its own copy.
--
-- jsonb rather than a table because this is a RECORD, not an index — nothing
-- joins it, nothing aggregates it, and no query filters on the geometry. A
-- handful of lat/lng rings is not a reason to take on PostGIS.
alter table public."quotes"
  add column if not exists "measurement_snapshot" jsonb;

comment on column public."quotes"."measurement_snapshot" is
  'Frozen record of the measurement and the pricing rule that produced this quote''s figure — total, unit, traced parts, term, basis, rate, price, as they were at quote time. Never re-derived from the Price Book on read; a later rate change must not rewrite history.';
