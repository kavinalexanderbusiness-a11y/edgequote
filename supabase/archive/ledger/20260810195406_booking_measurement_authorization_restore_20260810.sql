-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260810195406
--   name    : booking_measurement_authorization_restore_20260810
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision,
  p_neighborhood text, p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user     uuid;
  v_customer uuid;
  v_property uuid;
  v_hood     text;
  v_found    boolean := false;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;

  if p_quote_id is null then return false; end if;

  select true, q.customer_id, q.property_id
    into v_found, v_customer, v_property
    from public.quotes q
   where q.id = p_quote_id and q.user_id = v_user;
  if not coalesce(v_found, false) then return false; end if;

  if (select count(*) from public.measurements
       where user_id = v_user and context = 'booking'
         and created_at > now() - interval '1 hour') >= 30 then
    return false;
  end if;

  select case
           when nullif(btrim(pr.neighborhood), '') is not null then btrim(pr.neighborhood)
           when length(btrim(coalesce(pr.postal_code, ''))) >= 3 then upper(left(btrim(pr.postal_code), 3))
           when nullif(btrim(coalesce(pr.city, '')), '')  is not null then btrim(pr.city)
           else 'Unknown'
         end
    into v_hood
    from public.properties pr
   where pr.id = v_property and pr.user_id = v_user;
  v_hood := coalesce(v_hood, 'Unknown');

  insert into public.measurements (user_id, quote_id, customer_id, property_id, lat, lng, neighborhood,
      context, source, confidence, building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, v_customer, v_property, p_lat, p_lng, v_hood,
      'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end $function$;

revoke execute on function public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)
  from public, anon, authenticated;
grant execute on function public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)
  to anon, authenticated, service_role;

-- Remove exactly the rows the mutation test's vulnerable window wrote. They are
-- unmistakable: the guard's own sentinel bucket, booking context, minutes old.
delete from public.measurements
 where neighborhood = 'ZZ-GUARD-BUCKET' and context = 'booking'
   and created_at > now() - interval '30 minutes';

do $$
declare
  v_src text;
  v_sig constant text := 'public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)';
  v_left int;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='record_booking_measurement';
  if v_src not like '%if p_quote_id is null then return false%' then
    raise exception 'the hardened definition did not take';
  end if;
  if not has_function_privilege('anon', v_sig, 'execute') then
    raise exception 'anon lost EXECUTE';
  end if;
  if (select proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='record_booking_measurement') like '%{=X/%' then
    raise exception 'EXECUTE is still granted to PUBLIC';
  end if;
  select count(*) into v_left from public.measurements where neighborhood = 'ZZ-GUARD-BUCKET';
  if v_left <> 0 then
    raise exception 'mutation-test rows were not cleaned up: % remain', v_left;
  end if;
  raise notice 'hardened definition restored and test rows removed';
end $$;