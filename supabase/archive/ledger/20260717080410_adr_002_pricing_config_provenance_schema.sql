-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717080410
--   name    : adr_002_pricing_config_provenance_schema
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pricing_config_versions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  valid_from    timestamptz not null,
  source        text not null check (source in ('recorded', 'reconstructed')),
  note          text,
  engine_version text not null,
  base_charge          numeric not null check (base_charge >= 0),
  mow_rate_per_1000    numeric not null check (mow_rate_per_1000 >= 0),
  budget_mult          numeric not null check (budget_mult > 0),
  market_mult          numeric not null check (market_mult > 0),
  recommended_mult     numeric not null check (recommended_mult > 0),
  premium_mult         numeric not null check (premium_mult > 0),
  travel_rate_per_km   numeric not null check (travel_rate_per_km >= 0),
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

alter table public.quotes
  add column if not exists pricing_config_version_id uuid references public.pricing_config_versions(id),
  add column if not exists value_grade text,
  add column if not exists nearby_count integer,
  add column if not exists price_source text;

create index if not exists quotes_pricing_config_version_idx
  on public.quotes (pricing_config_version_id) where pricing_config_version_id is not null;

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
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_engine_price_needs_config') then
    alter table public.quotes add constraint quotes_engine_price_needs_config
      check (price_source is distinct from 'engine' or pricing_config_version_id is not null);
  end if;
end $$;

insert into public.pricing_config_versions (
  user_id, valid_from, source, note, engine_version,
  base_charge, mow_rate_per_1000, budget_mult, market_mult,
  recommended_mult, premium_mult, travel_rate_per_km,
  crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy
)
select
  s.user_id,
  coalesce(s.updated_at, now()),
  'recorded',
  'Seeded by ADR-002 migration 1 from the live business_settings row. No historical quote is linked to this version.',
  'v1',
  case when coalesce(s.pricing_base_charge, 0) > 0 then s.pricing_base_charge else 28 end,
  case when coalesce(s.pricing_mow_rate, 0) > 0 then s.pricing_mow_rate else 15 end,
  0.8,
  0.92,
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