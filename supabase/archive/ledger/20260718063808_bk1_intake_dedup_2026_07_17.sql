-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260718063808
--   name    : bk1_intake_dedup_2026_07_17
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.resolve_intake_customer(
  p_user uuid, p_name text, p_email text, p_phone text, p_address text,
  p_city text, p_province text, p_postal text, p_source text, p_notes text default null
) returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_customer uuid;
  v_digits text;
  v_email text := lower(nullif(trim(p_email), ''));
  v_phone text := nullif(trim(p_phone), '');
  v_address text := nullif(trim(p_address), '');
begin
  v_digits := right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10);
  if length(v_digits) = 10 then
    select id into v_customer from public.customers
      where user_id = p_user and phone is not null
        and right(regexp_replace(phone, '\D', '', 'g'), 10) = v_digits
      order by created_at desc limit 1;
  end if;
  if v_customer is null and v_email is not null then
    select id into v_customer from public.customers
      where user_id = p_user and lower(coalesce(email, '')) = v_email
      order by created_at desc limit 1;
  end if;
  if v_customer is null and v_address is not null then
    select id into v_customer from public.customers
      where user_id = p_user and lower(coalesce(address, '')) = lower(v_address)
      order by created_at desc limit 1;
  end if;

  if v_customer is null then
    insert into public.customers (
      user_id, name, email, phone, address, city, province, postal_code,
      acquisition_source, notes
    ) values (
      p_user, p_name, v_email, v_phone, v_address,
      nullif(trim(p_city), ''), coalesce(nullif(trim(p_province), ''), 'AB'), nullif(trim(p_postal), ''),
      p_source, nullif(trim(p_notes), '')
    ) returning id into v_customer;
  else
    update public.customers set
      phone = coalesce(phone, v_phone),
      email = coalesce(email, v_email)
    where id = v_customer;
  end if;

  return v_customer;
end;
$$;

create or replace function public.resolve_intake_property(
  p_user uuid, p_customer uuid, p_address text, p_city text, p_province text, p_postal text,
  p_lat double precision default null, p_lng double precision default null,
  p_sqft numeric default null, p_polygon jsonb default null,
  p_place_id text default null, p_maps_url text default null,
  p_travel_km numeric default null, p_travel_fee numeric default null
) returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_prop uuid;
  v_address text := nullif(trim(p_address), '');
begin
  if v_address is not null then
    select id into v_prop from public.properties
      where customer_id = p_customer and lower(coalesce(address, '')) = lower(v_address)
      order by is_primary desc nulls last, created_at asc limit 1;
  end if;

  if v_prop is null then
    insert into public.properties (
      customer_id, user_id, address, city, province, postal_code, lat, lng,
      lawn_sqft, lawn_polygon, google_place_id, maps_url,
      property_travel_distance_km, property_travel_fee, is_primary
    ) values (
      p_customer, p_user, v_address,
      nullif(trim(p_city), ''), coalesce(nullif(trim(p_province), ''), 'AB'), nullif(trim(p_postal), ''),
      p_lat, p_lng, p_sqft, p_polygon,
      nullif(trim(p_place_id), ''), nullif(trim(p_maps_url), ''),
      p_travel_km, p_travel_fee,
      not exists (select 1 from public.properties where customer_id = p_customer)
    ) returning id into v_prop;
  end if;

  return v_prop;
end;
$$;

revoke all on function public.resolve_intake_customer(uuid, text, text, text, text, text, text, text, text, text) from public;
revoke all on function public.resolve_intake_property(uuid, uuid, text, text, text, text, double precision, double precision, numeric, jsonb, text, text, numeric, numeric) from public;

CREATE OR REPLACE FUNCTION public.submit_booking(p_token text, p_name text, p_email text, p_phone text, p_address text, p_city text, p_province text, p_postal text, p_lat double precision, p_lng double precision, p_sqft numeric, p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric, p_cadence text, p_notes text DEFAULT NULL::text, p_hear_about text DEFAULT NULL::text, p_referral_code text DEFAULT NULL::text, p_utm jsonb DEFAULT NULL::jsonb, p_photos text[] DEFAULT NULL::text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
        v_source text; v_meta jsonb; v_photo_count int := coalesce(array_length(p_photos, 1), 0);
        v_service text; v_cfg uuid;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(trim(p_name), '') = '' then return null; end if;

  v_service := coalesce(
    nullif(trim(p_service_type), ''),
    (select s.name from public.service_templates s
      where s.user_id = v_user and s.is_active
      order by s.sort_order, s.name limit 1),
    'Service');

  v_cfg := public.ensure_pricing_config_version(v_user);

  v_source := coalesce(nullif(trim(p_hear_about), ''), nullif(p_utm->>'source', ''), 'Online Booking');
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'hear_about', p_hear_about, 'referral_code', p_referral_code, 'utm', p_utm,
    'photos', to_jsonb(p_photos), 'additional_notes', p_notes));

  v_customer := public.resolve_intake_customer(
    v_user, left(p_name, 200), p_email, p_phone, p_address, p_city, p_province, p_postal, v_source, p_notes);

  v_property := public.resolve_intake_property(
    v_user, v_customer, p_address, p_city, p_province, p_postal, p_lat, p_lng, nullif(p_sqft, 0));

  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
    from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, notes, lead_meta,
      price_source, pricing_config_version_id)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, v_service,
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'draft', nullif(p_sqft, 0), v_property, nullif(trim(p_notes), ''), v_meta,
      case when v_cfg is not null then 'engine' else null end, v_cfg)
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking (review) — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time')
      || ' · via ' || v_source || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || case when nullif(trim(p_referral_code), '') is not null then ' · ref:' || p_referral_code else '' end || ' · draft ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $function$;

CREATE OR REPLACE FUNCTION public.submit_website_lead(p_token text, p_payload jsonb, p_source text DEFAULT 'Website'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_lead uuid; v_convo uuid;
  v_phone text; v_email text; v_name text; v_first text; v_last text; v_address text;
  v_summary text; v_services text;
  v_budget text; v_schedule text; v_contact text;
  v_sqft text; v_est text; v_maps text; v_freq text; v_yard text; v_notes text; v_polygon jsonb;
  v_limit int; v_recent int;
  v_city text; v_province text; v_postal text; v_place text;
  v_source text := coalesce(nullif(trim(p_source), ''), 'Website');
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;

  select coalesce(website_lead_hourly_limit, 30) into v_limit from public.business_settings where user_id = v_user;
  if coalesce(v_limit, 0) > 0 then
    select count(*) into v_recent from public.website_leads where user_id = v_user and created_at > now() - interval '1 hour';
    if v_recent >= v_limit then
      raise log 'submit_website_lead: rate limit reached for user % (% leads in last hour, limit %)', v_user, v_recent, v_limit;
      return json_build_object('error', 'rate_limited');
    end if;
  end if;

  v_first    := nullif(trim(coalesce(p_payload->>'firstName', p_payload->>'first_name', '')), '');
  v_last     := nullif(trim(coalesce(p_payload->>'lastName',  p_payload->>'last_name',  '')), '');
  v_name     := nullif(trim(coalesce(p_payload->>'fullName',  p_payload->>'name', concat_ws(' ', v_first, v_last))), '');
  v_phone    := nullif(trim(coalesce(p_payload->>'phone', '')), '');
  v_email    := lower(nullif(trim(coalesce(p_payload->>'email', '')), ''));
  v_address  := nullif(trim(coalesce(p_payload->>'address', p_payload->>'serviceAddress', '')), '');
  v_services := nullif(trim(coalesce(p_payload->>'requestedServices', p_payload->>'services', p_payload->>'serviceType', p_payload->>'services_needed', '')), '');
  v_budget   := nullif(trim(coalesce(p_payload->>'budget', p_payload->>'budgetRange', '')), '');
  v_schedule := nullif(trim(coalesce(p_payload->>'preferredSchedule', p_payload->>'preferred_schedule', p_payload->>'schedule', p_payload->>'timeline', p_payload->>'preferred_date', '')), '');
  v_contact  := nullif(trim(coalesce(p_payload->>'preferredContact', p_payload->>'preferred_contact', p_payload->>'contactMethod', '')), '');
  v_sqft     := nullif(coalesce(p_payload->>'lawnSqft', p_payload->>'lawn_sqft', p_payload->>'lawn_area_sqft'), '');
  v_est      := nullif(coalesce(p_payload->>'estimatedPrice', p_payload->>'estimated_quote'), '');
  v_maps     := nullif(coalesce(p_payload->>'mapsUrl', p_payload->>'maps_url', p_payload->>'map_link'), '');
  v_freq     := nullif(coalesce(p_payload->>'frequency', p_payload->>'mowing_frequency'), '');
  v_yard     := nullif(coalesce(p_payload->>'yardCondition', p_payload->>'yard_condition'), '');
  v_notes    := nullif(coalesce(p_payload->>'notes', p_payload->>'message'), '');
  v_polygon  := coalesce(p_payload->'polygon', p_payload->'lawn_polygon');
  v_city     := nullif(p_payload->>'city', '');
  v_province := coalesce(nullif(p_payload->>'province', ''), 'AB');
  v_postal   := nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), '');
  v_place    := nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), '');

  v_customer := public.resolve_intake_customer(
    v_user, coalesce(v_name, v_source || ' lead'), v_email, v_phone, v_address,
    v_city, v_province, v_postal, v_source);

  v_prop := public.resolve_intake_property(
    v_user, v_customer, coalesce(v_address, v_source || ' lead'),
    v_city, v_province, v_postal,
    nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
    v_sqft::numeric, v_polygon, v_place, v_maps,
    nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
    nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric);

  insert into public.website_leads (
    user_id, customer_id, status, raw_submission, submitted_at,
    contact_first, contact_last, contact_name, phone, email, preferred_contact,
    address, city, province, postal_code, place_id, maps_url, lat, lng,
    lawn_sqft, lawn_polygon, sections, travel_distance_km, travel_fee,
    requested_services, frequency, yard_condition, website_estimated_price,
    budget, preferred_schedule, notes
  ) values (
    v_user, v_customer, 'new', p_payload, nullif(p_payload->>'submittedAt', '')::timestamptz,
    v_first, v_last, v_name, v_phone, v_email, v_contact,
    v_address, v_city, v_province, v_postal, v_place, v_maps,
    nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
    v_sqft::numeric,
    v_polygon, p_payload->'sections',
    nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
    nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric,
    v_services, v_freq, v_yard,
    v_est::numeric,
    v_budget, v_schedule, v_notes
  ) returning id into v_lead;

  v_summary := 'New ' || v_source || ' lead'
    || case when v_services is not null then ' — ' || v_services else '' end
    || case when v_address is not null then ' · ' || v_address else '' end
    || case when v_budget is not null then ' · Budget: ' || v_budget else '' end
    || case when v_schedule is not null then ' · Prefers ' || v_schedule else '' end
    || case when v_contact is not null then ' · via ' || v_contact else '' end
    || case when v_sqft is not null then ' · ' || v_sqft || ' ft² lawn' else '' end
    || case when v_est is not null then ' · est. $' || v_est else '' end;
  insert into public.service_requests (user_id, customer_id, message, status)
    values (v_user, v_customer, v_summary, 'new');

  update public.conversations set lead_status = 'new'
    where user_id = v_user and customer_id = v_customer;
  select id into v_convo from public.conversations where user_id = v_user and customer_id = v_customer limit 1;
  update public.website_leads set conversation_id = v_convo where id = v_lead;

  return json_build_object('lead_id', v_lead, 'customer_id', v_customer, 'source', v_source);
end; $function$;