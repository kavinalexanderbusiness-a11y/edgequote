-- ── MEAS-1: property_measurements is the SOLE authority for lawn_sqft ─────────
-- APPLIED to production 2026-07-17 via Supabase MCP; guard proven by execution
-- (mirror write passes · divergent legacy write rejected · agreeing write passes;
-- run in a rolled-back transaction, prod re-read at 0 property_measurements rows).
--
-- Measurement Engine V2 (RUN-2026-07-16) made property_measurements the typed
-- sensor of record and a trigger derives properties.lawn_sqft from it. But legacy
-- app paths (the quote save, MeasureTool) still wrote lawn_sqft DIRECTLY, so a
-- later ledger edit could silently REVERT the number the pricing engine reads —
-- the "canonical seam introduced, old path still runs" pattern, in the one place
-- it corrupts money. This enforces the single-writer invariant in the DB.
--
-- Cooperates with the mirror: the mirror always sets lawn_sqft to the ledger
-- row's value, so its write AGREES and passes; only a direct write that DISAGREES
-- with the ledger is rejected. Additive, idempotent. Inert until a property has a
-- 'lawn' ledger row (prod had 0 at apply time), so the 45 existing legacy
-- lawn_sqft values keep working untouched until each is re-measured through V2.
create or replace function public.guard_lawn_sqft_writer() returns trigger
language plpgsql as $$
declare v_lawn numeric;
begin
  if new.lawn_sqft is not distinct from old.lawn_sqft then return new; end if;
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
