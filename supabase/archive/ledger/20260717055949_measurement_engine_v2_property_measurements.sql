-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717055949
--   name    : measurement_engine_v2_property_measurements
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Measurement Engine V2: typed measurements ────────────────────────────────
-- Additive. Nothing dropped, no existing column altered, pricing/quoting untouched.

-- 1. Enable the composite-FK tenancy pattern used elsewhere (time_entries etc).
--    id is already unique, so this is an index, not a data change.
do $$ begin
  alter table public.properties add constraint properties_id_user_unique unique (id, user_id);
exception when duplicate_object then null; end $$;

-- 2. THE typed measurement ledger.
create table if not exists public.property_measurements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null,

  kind text not null,
  unit text not null,
  value numeric(12,2) not null,

  -- Rings / paths / points as drawn. Storing the geometry (not just the number)
  -- is what makes a measurement re-derivable and editable later; the old tools
  -- kept only `lawn_polygon` for lawn and threw every other shape away.
  shapes jsonb not null default '[]'::jsonb,

  source text not null,
  confidence text not null,
  -- NOT NULL on purpose: a confidence with no reason is decoration. The audit's
  -- finding was that the product renders invented numbers as confirmed ones;
  -- forcing a sentence at the schema level makes that harder to do by accident.
  confidence_reason text not null,
  needs_review boolean not null default false,
  notes text,
  measured_at timestamptz not null default now(),

  constraint property_measurements_property_same_owner
    foreign key (property_id, user_id) references public.properties(id, user_id) on delete cascade,

  constraint property_measurements_kind_known
    check (kind in ('lawn','mulch','gravel','rock','concrete','fencing','hedges','trees','snow')),
  constraint property_measurements_unit_known
    check (unit in ('sqft','linear_ft','count')),
  constraint property_measurements_source_known
    check (source in ('traced','auto','manual')),
  constraint property_measurements_confidence_known
    check (confidence in ('high','medium','low')),
  constraint property_measurements_value_nonneg check (value >= 0),
  constraint property_measurements_reason_present check (length(trim(confidence_reason)) > 0),

  -- THE integrity rule that makes a unit trustworthy: the unit must follow from
  -- the kind. A fence measured in ft² was exactly the old bug (both tools were
  -- polygon-area-only and every number they produced was square feet). The DB now
  -- refuses it outright rather than trusting every caller to remember.
  constraint property_measurements_unit_matches_kind check (
    (kind in ('lawn','mulch','gravel','rock','concrete','snow') and unit = 'sqft')
    or (kind in ('fencing','hedges') and unit = 'linear_ft')
    or (kind = 'trees' and unit = 'count')
  ),

  -- One current measurement per kind per property. Re-measuring updates the row;
  -- history lives in properties.measurement_history, which already exists.
  constraint property_measurements_one_per_kind unique (property_id, kind)
);

create index if not exists property_measurements_user_idx on public.property_measurements (user_id);
create index if not exists property_measurements_property_idx on public.property_measurements (property_id);
create index if not exists property_measurements_kind_idx on public.property_measurements (user_id, kind);

drop trigger if exists property_measurements_updated_at on public.property_measurements;
create trigger property_measurements_updated_at before update on public.property_measurements
  for each row execute function public.set_updated_at();

-- 3. Legacy mirror — the migration path, enforced by the DB rather than by hope.
--
-- properties.lawn_sqft / fence_length / mulch_area / rock_area are read TODAY by
-- pricing and by the customer portal ("12 ft fence"). Three of the four were
-- written by NOTHING in the codebase — declared, rendered to customers, and never
-- produced. This trigger makes them live, derived from the new table.
--
-- Why a trigger and not app-side dual-write: two writers drift. With one writer
-- (property_measurements) and a derived mirror, the legacy columns cannot
-- disagree with the engine. When Quote V2 reads the table directly, drop the
-- trigger and the columns — nothing else has to change.
--
-- concrete/gravel/hedges/trees/snow have NO legacy column and are deliberately
-- not squeezed into driveway_area: a patio is not a driveway, and that column is
-- shown to a customer.
create or replace function public.mirror_measurement_to_property() returns trigger
language plpgsql as $$
declare target uuid; v numeric;
begin
  target := coalesce(new.property_id, old.property_id);
  v := case when tg_op = 'DELETE' then null else new.value end;

  case coalesce(new.kind, old.kind)
    when 'lawn'    then update public.properties set lawn_sqft    = v where id = target;
    when 'fencing' then update public.properties set fence_length = v where id = target;
    when 'mulch'   then update public.properties set mulch_area   = v where id = target;
    when 'rock'    then update public.properties set rock_area    = v where id = target;
    else null;
  end case;
  return null;
end $$;

drop trigger if exists property_measurements_mirror on public.property_measurements;
create trigger property_measurements_mirror
  after insert or update of value, kind or delete on public.property_measurements
  for each row execute function public.mirror_measurement_to_property();

-- 4. RLS — same shape as every other tenant table.
alter table public.property_measurements enable row level security;

drop policy if exists property_measurements_select on public.property_measurements;
drop policy if exists property_measurements_insert on public.property_measurements;
drop policy if exists property_measurements_update on public.property_measurements;
drop policy if exists property_measurements_delete on public.property_measurements;
create policy property_measurements_select on public.property_measurements for select using (auth.uid() = user_id);
create policy property_measurements_insert on public.property_measurements for insert with check (auth.uid() = user_id);
create policy property_measurements_update on public.property_measurements for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy property_measurements_delete on public.property_measurements for delete using (auth.uid() = user_id);

comment on table public.property_measurements is
  'THE typed measurement ledger (Measurement Engine V2). One row per (property, kind). Unit follows kind by CHECK. Legacy properties.lawn_sqft/fence_length/mulch_area/rock_area are DERIVED from here by trigger for existing pricing/portal readers — drop them once Quote V2 reads this table.';