-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor. Backward-compatible RPC update — NOT a
-- schema migration (no new tables/columns). Reuses the existing submit_website_lead
-- and only adds field-name ALIASES so the live marketing-site payload populates.
-- ════════════════════════════════════════════════════════════
--
-- The website posts snake_case keys that didn't match the RPC's canonical camelCase,
-- so budget/schedule/estimate/sqft/frequency/maps silently dropped. This adds each
-- live key as a coalesce FALLBACK (canonical key still wins), so nothing changes for
-- existing callers. Idempotent — safe to run more than once.
--   services_needed → requested_services   preferred_date  → preferred_schedule
--   lawn_area_sqft  → lawn_sqft             estimated_quote → website_estimated_price
--   mowing_frequency→ frequency             map_link        → maps_url
--   lawn_polygon    → lawn_polygon          message         → notes (fallback)

create or replace function public.submit_website_lead(p_token text, p_payload jsonb, p_source text default 'Website')
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_lead uuid; v_convo uuid;
  v_phone text; v_email text; v_name text; v_first text; v_last text; v_address text;
  v_digits text; v_summary text; v_services text;
  v_budget text; v_schedule text; v_contact text;
  v_sqft text; v_est text; v_maps text; v_freq text; v_yard text; v_notes text; v_polygon jsonb;
  v_limit int; v_recent int;
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
  -- Field aliases: accept BOTH EdgeQuote's canonical camelCase keys AND the live
  -- marketing-site snake_case keys. Backward-compatible — canonical keys win, the
  -- live-site key is only a fallback. (services_needed / preferred_date / lawn_area_sqft
  -- / estimated_quote / mowing_frequency / map_link / lawn_polygon / message.)
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

  v_digits := right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10);
  if length(v_digits) = 10 then
    select id into v_customer from public.customers
      where user_id = v_user and phone is not null
        and right(regexp_replace(phone, '\D', '', 'g'), 10) = v_digits
      order by created_at desc limit 1;
  end if;
  if v_customer is null and v_email is not null then
    select id into v_customer from public.customers
      where user_id = v_user and lower(coalesce(email, '')) = v_email order by created_at desc limit 1;
  end if;
  if v_customer is null and v_address is not null then
    select id into v_customer from public.customers
      where user_id = v_user and lower(coalesce(address, '')) = lower(v_address) order by created_at desc limit 1;
  end if;

  if v_customer is null then
    insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source)
    values (v_user, coalesce(v_name, v_source || ' lead'), v_email, v_phone, v_address,
            nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
            nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
            v_source)
    returning id into v_customer;
  else
    update public.customers set
      phone = coalesce(phone, v_phone),
      email = coalesce(email, v_email)
    where id = v_customer;
  end if;

  select id into v_prop from public.properties
    where customer_id = v_customer and v_address is not null and lower(coalesce(address, '')) = lower(v_address)
    order by is_primary desc nulls last, created_at asc limit 1;
  if v_prop is null then
    insert into public.properties (
      customer_id, user_id, address, city, province, postal_code, lat, lng,
      lawn_sqft, lawn_polygon, google_place_id, maps_url, property_travel_distance_km, property_travel_fee, is_primary
    ) values (
      v_customer, v_user, coalesce(v_address, v_source || ' lead'),
      nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
      nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
      nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
      v_sqft::numeric,
      v_polygon,
      nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
      v_maps,
      nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
      nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric,
      not exists (select 1 from public.properties where customer_id = v_customer)
    ) returning id into v_prop;
  end if;

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
    v_address, nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
    nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
    nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
    v_maps,
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
end; $$;
grant execute on function public.submit_website_lead(text, jsonb, text) to anon, authenticated;
