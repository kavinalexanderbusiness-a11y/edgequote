-- ADR-002 · Pricing Configuration Provenance · MIGRATION 1 of 3: the schema
--
-- THE PROBLEM (proven by execution, not theorised):
--   A quote's price derives from state that no longer exists. `business_settings` is
--   ONE mutable row with ONE updated_at. The base charge has moved at least three
--   times (~$20-22 June → $50 Jul 5-16 → $45 since 2026-07-17 07:00:34). Supply the
--   config that was live at write time and the engine reproduces 95% of quotes;
--   supply today's config and it reproduces 1 of 46. The engine is deterministic and
--   correct — the INPUTS are gone.
--
-- THE DECISION (ADR-002, approved 2026-07-17): the HYBRID.
--   Two categories of missing input, separated by ONE test:
--     "Could two quotes written in the SAME SECOND legitimately differ on this?"
--       NO  → configuration (owner-authored, discrete, shared across an era) → VERSION it.
--       YES → derived state (computed from the world at that instant)        → SNAPSHOT it.
--
--   Version-only cannot work: valueGrade is computed from live route context — where
--   the jobs happened to be that day. Property 0071's measurement snapshot, taken TWO
--   SECONDS before its quote, reads the neutral curve; the quote reads A+. Config did
--   not change in those two seconds; the world did.
--
--   Snapshot-only cannot work either: a snapshot records what a value WAS for one
--   quote, never that a change HAPPENED, when, or to what. Reconstructing this
--   history required grid-searching quote data — it recovered July at 95% and could
--   not recover June at all. That exercise IS snapshot-only's auditability model.
--
-- Precedent: `wage_history` already exists. Wages are versioned; prices were not.
-- This migration closes that asymmetry.
--
-- MIGRATION 1 IS DELIBERATELY ADDITIVE AND UNENFORCED. It creates the table and the
-- columns and nothing else. The forward-only NOT NULL requirement lands in migration
-- 3, AFTER every writer (TypeScript and plpgsql) records — because `book_service` is
-- a public, unauthenticated endpoint and a constraint it cannot satisfy would take
-- live bookings down. Order matters more than speed.

begin;

-- ── The versioned configuration ──────────────────────────────────────────────
-- Immutable rows. One per deliberate change to the rate card.
create table if not exists public.pricing_config_versions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),

  -- When this configuration took effect. For the seeded v1 this is
  -- business_settings.updated_at — a RECORDED fact, not an inference.
  valid_from    timestamptz not null,

  -- ADR-002 requirement. 'recorded' = we watched it happen. 'reconstructed' = it was
  -- inferred after the fact (e.g. by fitting stored prices to a candidate rate card).
  -- The column exists from day one specifically so that IF the owner ever chooses to
  -- reconstruct the July era, the reconstruction can never be mistaken for recorded
  -- truth. Nothing is reconstructed by this migration — see the no-backfill note.
  source        text not null check (source in ('recorded', 'reconstructed')),
  note          text,

  -- Pins how the row is READ. A version row is immutable, but the code that
  -- interprets it is not; if the meaning of a field ever changes, this says which
  -- meaning applied. (This is the mitigation for the one real argument against
  -- versioning: semantic drift. Under a snapshot model the stale shape spreads to
  -- every quote ever written; here it stays in ~50 rows and stays migratable.)
  engine_version text not null,

  -- The seven PricingConfig fields, exactly as lib/pricing.ts defines them.
  -- NOTE: budget_mult and market_mult are NOT settings-backed today — they come from
  -- DEFAULT_PRICING in code (0.8 / 0.92). That is precisely why they are versioned
  -- here: a code change moves them silently, and this row records what was in force.
  base_charge          numeric not null check (base_charge >= 0),
  mow_rate_per_1000    numeric not null check (mow_rate_per_1000 >= 0),
  budget_mult          numeric not null check (budget_mult > 0),
  market_mult          numeric not null check (market_mult > 0),
  recommended_mult     numeric not null check (recommended_mult > 0),
  premium_mult         numeric not null check (premium_mult > 0),
  travel_rate_per_km   numeric not null check (travel_rate_per_km >= 0),

  -- Not part of PricingConfig, but they move the number that lands in the row:
  -- fee recovery is baked into initial_price at insert (every non-$5 stored price
  -- divides by exactly 1.03 — that is applyFeeRecovery), and crew cost drives the
  -- margin the owner is shown while choosing.
  crew_cost_per_hour   numeric not null check (crew_cost_per_hour >= 0),
  fee_recovery_percent numeric not null check (fee_recovery_percent >= 0),
  payment_fee_strategy text not null
);

create index if not exists pricing_config_versions_user_valid_idx
  on public.pricing_config_versions (user_id, valid_from desc);

alter table public.pricing_config_versions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy where polrelid = 'public.pricing_config_versions'::regclass and polname = 'pricing_config_versions: select own') then
    create policy "pricing_config_versions: select own" on public.pricing_config_versions
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.pricing_config_versions'::regclass and polname = 'pricing_config_versions: insert own') then
    create policy "pricing_config_versions: insert own" on public.pricing_config_versions
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

-- Deliberately NO update or delete policy. See the trigger below — but RLS alone is
-- not the guard, because SECURITY DEFINER functions bypass it.

-- ── Immutability, enforced by the DATABASE ───────────────────────────────────
-- Per the project's standing principle: DB constraints over app logic. A version row
-- that priced a quote must be impossible to change, not merely unfashionable to
-- change. This trigger holds even for SECURITY DEFINER callers and service-role keys,
-- which is exactly why it is a trigger and not an RLS policy or a code review habit.
create or replace function public.pricing_config_versions_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'pricing_config_versions is append-only (ADR-002): a configuration that priced a quote must never change. Insert a new version instead.'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists pricing_config_versions_no_mutate on public.pricing_config_versions;
create trigger pricing_config_versions_no_mutate
  before update or delete on public.pricing_config_versions
  for each row execute function public.pricing_config_versions_immutable();

-- ── The per-quote snapshot ───────────────────────────────────────────────────
-- Nullable here ON PURPOSE. Historical quotes carry no version and must read
-- *unknown* forever — see the no-backfill note. Migration 3 requires these of NEW
-- rows only, once every writer records them.
alter table public.quotes
  add column if not exists pricing_config_version_id uuid references public.pricing_config_versions(id),
  -- Derived state: computed from the world at write time, unreconstructable later.
  -- valueGrade comes from live route context (ProspectScore: 'A+' | Grade).
  add column if not exists value_grade text,
  add column if not exists nearby_count integer,
  -- How this price was derived at all. Needed because not every writer uses the
  -- engine: book_service prices flat from service_templates.default_rate and touches
  -- pricing_config never — recording a config version against it would be a LIE.
  -- Reuses the vocabulary QuoteBuilder already speaks (type PriceOrigin).
  add column if not exists price_source text;

create index if not exists quotes_pricing_config_version_idx
  on public.quotes (pricing_config_version_id) where pricing_config_version_id is not null;

-- Domain constraints (safe now — every existing row is NULL on all four columns).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_value_grade_valid') then
    alter table public.quotes add constraint quotes_value_grade_valid
      check (value_grade is null or value_grade in ('A+','A','B','C','D','F'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_nearby_count_nonneg') then
    alter table public.quotes add constraint quotes_nearby_count_nonneg
      check (nearby_count is null or nearby_count >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_price_source_valid') then
    alter table public.quotes add constraint quotes_price_source_valid
      check (price_source is null or price_source in ('engine','template_rate'));
  end if;
  -- Engine-priced ⇒ the configuration that priced it MUST be stated. This one is safe
  -- to add today because no row is 'engine' yet, and it is the heart of the ADR:
  -- a quote must not claim the engine priced it without saying which engine config did.
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_engine_price_needs_config') then
    alter table public.quotes add constraint quotes_engine_price_needs_config
      check (price_source is distinct from 'engine' or pricing_config_version_id is not null);
  end if;
end $$;

-- ── Seed v1 — RECORDED, not reconstructed ────────────────────────────────────
-- This is not a backfill. It records the configuration that is live RIGHT NOW, which
-- we know exactly because we can read it.
--
-- valid_from is the moment of RECORDING — deliberately NOT business_settings.updated_at.
-- I tried updated_at first and it was an over-claim: that column stamps the last touch
-- of ANY settings field, not a pricing change (it read 07:00:34 and then 07:42:19 on the
-- same day). This config may well have been in force earlier. That is unknown, and
-- unknown stays unknown — asserting a start time we cannot observe is precisely the
-- false precision this ADR exists to prevent.
--
-- ⛔ NO QUOTE IS LINKED TO IT. Per ADR-002 and the owner's standing rule (the same one
-- applied to quote expiry and the accept snapshot): forward-only, unknown stays
-- unknown. The 55 historical quotes read *unknown* and learning must skip them
-- explicitly rather than substitute today's config — which is exactly the false
-- precision this whole exercise exists to prevent. July IS ~95% recoverable and June
-- is not; recovering July would still be inference, and inference is what `source`
-- exists to label if the owner ever rules that way.
insert into public.pricing_config_versions (
  user_id, valid_from, source, note, engine_version,
  base_charge, mow_rate_per_1000, budget_mult, market_mult,
  recommended_mult, premium_mult, travel_rate_per_km,
  crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy
)
select
  s.user_id,
  now(),
  'recorded',
  'Seeded by ADR-002 migration 1 by reading the live business_settings row. '
    || 'valid_from is the moment of RECORDING, not the moment the rate card changed: '
    || 'business_settings.updated_at stamps the last touch of ANY settings field, not necessarily a pricing change. '
    || 'This configuration may well have been in effect earlier — that is unknown, and unknown stays unknown. '
    || 'No historical quote is linked to this version.',
  'v1',
  -- Mirrors pricingConfigFromSettings(): pos(value, DEFAULT_PRICING.x) — a non-positive
  -- or null setting falls back to the code default, so the row records what the engine
  -- would ACTUALLY have used, not what the column literally held.
  case when coalesce(s.pricing_base_charge, 0) > 0 then s.pricing_base_charge else 28 end,
  case when coalesce(s.pricing_mow_rate, 0) > 0 then s.pricing_mow_rate else 15 end,
  0.8,   -- DEFAULT_PRICING.budgetMult — code constant, not settings-backed
  0.92,  -- DEFAULT_PRICING.marketMult — code constant, not settings-backed
  case when coalesce(s.pricing_recommended_mult, 0) > 0 then s.pricing_recommended_mult else 1.0 end,
  case when coalesce(s.pricing_premium_mult, 0) > 0 then s.pricing_premium_mult else 1.2 end,
  case when coalesce(s.pricing_travel_rate, 0) > 0 then s.pricing_travel_rate else 1.5 end,
  coalesce(s.crew_cost_per_hour, 40),
  coalesce(s.fee_recovery_percent, 3),
  coalesce(s.payment_fee_strategy, 'global_price_increase')
from public.business_settings s
where not exists (
  select 1 from public.pricing_config_versions v where v.user_id = s.user_id
);

commit;
