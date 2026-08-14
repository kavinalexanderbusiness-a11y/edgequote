-- ── Measurement Engine V2: typed measurements ────────────────────────────────
-- APPLIED to production 2026-07-16 via Supabase MCP, read back live, every guard
-- proven by execution (below). Committed because the repo is the source of truth
-- for migration history.
--
-- WHY
-- Measurement had four independent implementations, each with its own
-- `M2_TO_SQFT = 10.7639` (MeasureTool, QuoteMeasure, BookingClient, autoMeasure).
-- All four were polygon-area-only, so EVERY number they produced was square feet
-- — the column is literally named `measured_sqft`. Consequences, per
-- MEASURE-AND-QUOTE-AUDIT.md:
--   * a fence could not be measured (it is a line, not an area);
--   * a tree could not be counted;
--   * tracing the same polygon for "Lawn Mowing" and "Fence Installation"
--     returned byte-identical output;
--   * `fence_length`, `mulch_area`, `rock_area` were declared, RENDERED TO
--     CUSTOMERS ("12 ft fence" in the portal) — and written by nothing at all.
-- This table gives a measurement a KIND and a UNIT, and makes those four columns
-- real instead of decorative.
--
-- THE INTEGRITY RULE — unit follows kind, enforced by CHECK.
-- `property_measurements_unit_matches_kind` makes "a fence stored in ft²"
-- impossible from any code path, rather than trusting every caller to remember.
-- Proven by execution: fencing/sqft, trees/sqft and lawn/linear_ft are all
-- rejected.
--
-- THE MIGRATION PATH — a derived mirror, not a dual write.
-- properties.lawn_sqft / fence_length / mulch_area / rock_area are read TODAY by
-- the pricing engine and the customer portal. A trigger derives them from this
-- table, so:
--   * pricing and the portal keep reading exactly what they read today — this
--     migration ships with ZERO changes to either;
--   * there is ONE writer, so the legacy columns cannot drift from the engine
--     (app-side dual-write always drifts eventually);
--   * when Quote V2 reads this table directly, drop the trigger and the columns.
-- concrete/gravel/hedges/trees/snow have NO legacy column and are deliberately
-- NOT squeezed into driveway_area — a patio is not a driveway, and that column is
-- shown to a customer.
--
-- SAFETY: additive only. One new table, one unique constraint on properties
-- (id is already unique, so it is an index, not a data change), one trigger.
-- Nothing dropped, nothing backfilled, no existing column altered. Idempotent.
--
-- VERIFICATION — executed against prod inside a transaction that was ROLLED BACK
-- (property_measurements re-read at 0 rows afterwards):
--   * fencing stored as 'sqft'      -> check_violation   ✅  (THE old bug)
--   * trees stored as 'sqft'        -> check_violation   ✅
--   * lawn stored as 'linear_ft'    -> check_violation   ✅
--   * confidence with a blank reason-> check_violation   ✅
--   * unknown kind 'roof'           -> check_violation   ✅
--   * negative value                -> check_violation   ✅
--   * two rows for the same kind    -> unique_violation  ✅
--   * MIRROR insert  -> properties.lawn_sqft = 5200, fence_length = 86   ✅
--   * MIRROR update  -> lawn_sqft = 6100                                 ✅
--   * MIRROR delete  -> lawn_sqft = NULL                                 ✅
-- lib/measure additionally verified by execution over 91 cases (Google-exact
-- geometry, unit-per-kind, confidence refusals, newest-row-wins). That run caught
-- a real bug: the first cut used the textbook trapezoid area formula, which
-- returns exactly HALF the correct area for a polygon touching a pole.

-- 1. Enable the composite-FK tenancy pattern used elsewhere (time_entries etc).
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
  -- is what makes a measurement re-derivable and editable; the old tools kept
  -- only `lawn_polygon` for lawn and threw every other shape away.
  shapes jsonb not null default '[]'::jsonb,

  source text not null,
  confidence text not null,
  -- NOT NULL on purpose: a confidence with no reason is decoration.
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

  constraint property_measurements_unit_matches_kind check (
    (kind in ('lawn','mulch','gravel','rock','concrete','snow') and unit = 'sqft')
    or (kind in ('fencing','hedges') and unit = 'linear_ft')
    or (kind = 'trees' and unit = 'count')
  ),

  constraint property_measurements_one_per_kind unique (property_id, kind)
);

create index if not exists property_measurements_user_idx on public.property_measurements (user_id);
create index if not exists property_measurements_property_idx on public.property_measurements (property_id);
create index if not exists property_measurements_kind_idx on public.property_measurements (user_id, kind);

drop trigger if exists property_measurements_updated_at on public.property_measurements;
create trigger property_measurements_updated_at before update on public.property_measurements
  for each row execute function public.set_updated_at();

-- 3. Legacy mirror (see the header).
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
