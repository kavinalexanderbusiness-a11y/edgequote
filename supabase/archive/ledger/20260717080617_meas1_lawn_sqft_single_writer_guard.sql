-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717080617
--   name    : meas1_lawn_sqft_single_writer_guard
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- MEAS-1 (launch blocker): make property_measurements the SOLE authority for
-- properties.lawn_sqft. The V2 mirror trigger already derives lawn_sqft from the
-- typed ledger, but legacy app paths (the quote save, MeasureTool) still wrote
-- lawn_sqft directly — so a later ledger edit could silently REVERT the number
-- the pricing engine reads. This guard makes that divergence impossible in the
-- DB, not in a comment.
--
-- HOW IT COOPERATES WITH THE MIRROR: the mirror always sets lawn_sqft to the
-- ledger row's value, so its write always AGREES and passes. Only a direct write
-- that DISAGREES with the ledger (a legacy path trying to diverge) is rejected.
--
-- BACKWARDS COMPAT: verified prod has 0 property_measurements rows, so this is
-- inert today; it begins governing a property only once that property has a
-- 'lawn' ledger row. The 45 existing legacy lawn_sqft values keep working
-- untouched until each is re-measured through V2.
create or replace function public.guard_lawn_sqft_writer() returns trigger
language plpgsql as $$
declare v_lawn numeric;
begin
  -- Only relevant when lawn_sqft actually changes (cheap: skips every other update).
  if new.lawn_sqft is not distinct from old.lawn_sqft then return new; end if;
  -- Once the typed ledger has a lawn row, its value is the ONLY legitimate
  -- lawn_sqft — which is exactly what the mirror writes. Anything else is a
  -- legacy direct write trying to diverge from the sensor of record.
  select value into v_lawn from public.property_measurements
    where property_id = new.id and kind = 'lawn';
  if found and new.lawn_sqft is distinct from v_lawn then
    raise exception 'lawn_sqft is derived from property_measurements (kind=lawn); save the measurement through lib/measure, never write lawn_sqft directly'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists properties_guard_lawn_sqft on public.properties;
create trigger properties_guard_lawn_sqft
  before update of lawn_sqft on public.properties
  for each row execute function public.guard_lawn_sqft_writer();