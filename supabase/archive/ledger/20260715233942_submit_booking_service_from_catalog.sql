-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715233942
--   name    : submit_booking_service_from_catalog
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- submit_booking: the service fallback comes from the owner's catalog, not a literal.
--
-- ONE expression changed. Everything else is the CURRENT live definition, read back
-- with pg_get_functiondef and replayed verbatim.
--
-- WHY: the booking funnel wrote `coalesce(nullif(p_service_type,''), 'Lawn Mowing')`.
-- The client was fixed to send the owner's real service, but the DEFAULT lived here —
-- so a null/empty service silently became "Lawn Mowing" no matter what the business
-- sells, and no client-side fix could reach it. A window cleaner's online bookings
-- were filed as lawn mowing by Postgres.
--
-- The new fallback asks the owner's own data (service_templates: active, in their
-- sort order — the same rule public_services and get_portal_data already use), and
-- only lands on the neutral 'Service' if they have no active services at all. It
-- never names a trade the platform invented.
--
-- Behaviour for the current owner is UNCHANGED: their first active template is
-- "Lawn Mowing" (sort_order 1), which is exactly what this used to hardcode.
CREATE OR REPLACE FUNCTION public.submit_booking(p_token text, p_name text, p_email text, p_phone text, p_address text, p_city text, p_province text, p_postal text, p_lat double precision, p_lng double precision, p_sqft numeric, p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric, p_cadence text, p_notes text DEFAULT NULL::text, p_hear_about text DEFAULT NULL::text, p_referral_code text DEFAULT NULL::text, p_utm jsonb DEFAULT NULL::jsonb, p_photos text[] DEFAULT NULL::text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
        v_source text; v_meta jsonb; v_photo_count int := coalesce(array_length(p_photos, 1), 0);
        v_service text;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(trim(p_name), '') = '' then return null; end if;

  -- The service the caller asked for; else the owner's primary offering from their
  -- OWN catalog; else a neutral label. Never a trade this platform picked.
  v_service := coalesce(
    nullif(trim(p_service_type), ''),
    (select s.name from public.service_templates s
      where s.user_id = v_user and s.is_active
      order by s.sort_order, s.name limit 1),
    'Service');

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

  insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, notes, lead_meta)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, v_service,
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'draft', nullif(p_sqft, 0), v_property, nullif(trim(p_notes), ''), v_meta)
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking (review) — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time')
      || ' · via ' || v_source || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || case when nullif(trim(p_referral_code), '') is not null then ' · ref:' || p_referral_code else '' end || ' · draft ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $function$;