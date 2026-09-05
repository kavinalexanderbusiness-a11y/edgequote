-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260810195334
--   name    : temp_mutation_test_vulnerable_measurement
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- TEMPORARY: the pre-fix (vulnerable) definition, to prove the guard fails on it.
-- Immediately replaced by the hardened version in the next migration.
create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision,
  p_neighborhood text, p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_user uuid;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;

  if (select count(*) from public.measurements
       where user_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    return false;
  end if;

  if p_quote_id is not null
     and not exists (select 1 from public.quotes q where q.id = p_quote_id and q.user_id = v_user)
  then
    return false;
  end if;

  insert into public.measurements (user_id, quote_id, lat, lng, neighborhood, context, source, confidence,
      building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, p_lat, p_lng, nullif(p_neighborhood, ''), 'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end $function$;