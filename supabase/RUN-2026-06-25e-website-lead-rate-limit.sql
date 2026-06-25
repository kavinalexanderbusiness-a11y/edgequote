
-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25e — Website-lead rate limiting (abuse protection)
-- ════════════════════════════════════════════════════════════
-- A leaked booking_token could be used to spam the public /api/website-lead
-- endpoint and mass-create customers/leads. This adds a CONFIGURABLE per-business
-- hourly cap inside submit_website_lead. Rejections are logged (raise log) and the
-- RPC returns {"error":"rate_limited"} so the route can answer 429. Setting the
-- limit to 0 disables the cap. SUPERSEDES the 2026-06-25d definition of
-- submit_website_lead (same signature → create-or-replace, no drop needed).
-- Idempotent + backward compatible.
alter table public.business_settings add column if not exists website_lead_hourly_limit int not null default 30;

create or replace function public.submit_website_lead(p_token text, p_payload jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_lead uuid; v_convo uuid;
  v_phone text; v_email text; v_name text; v_first text; v_last text; v_address text;
  v_digits text; v_summary text; v_services text;
  v_limit int; v_recent int;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;

  -- Rate limit: protect against a leaked booking_token spamming leads. Configurable
  -- via business_settings.website_lead_hourly_limit (0 = unlimited). Logged on reject.
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
  v_services := nullif(trim(coalesce(p_payload->>'requestedServices', p_payload->>'services', p_payload->>'serviceType', '')), '');

  -- DEDUP customer: phone (last 10) → email → address; else create new.
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
    values (v_user, coalesce(v_name, 'Website lead'), v_email, v_phone, v_address,
            nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
            nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
            'Website')
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
      v_customer, v_user, coalesce(v_address, 'Website lead'),
      nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
      nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
      nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
      nullif(coalesce(p_payload->>'lawnSqft', p_payload->>'lawn_sqft'), '')::numeric,
      p_payload->'polygon',
      nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
      nullif(coalesce(p_payload->>'mapsUrl', p_payload->>'maps_url'), ''),
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
    requested_services, frequency, yard_condition, website_estimated_price, notes
  ) values (
    v_user, v_customer, 'new', p_payload, nullif(p_payload->>'submittedAt', '')::timestamptz,
    v_first, v_last, v_name, v_phone, v_email, nullif(p_payload->>'preferredContact', ''),
    v_address, nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
    nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
    nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
    nullif(coalesce(p_payload->>'mapsUrl', p_payload->>'maps_url'), ''),
    nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
    nullif(coalesce(p_payload->>'lawnSqft', p_payload->>'lawn_sqft'), '')::numeric,
    p_payload->'polygon', p_payload->'sections',
    nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
    nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric,
    v_services, nullif(p_payload->>'frequency', ''), nullif(p_payload->>'yardCondition', ''),
    nullif(p_payload->>'estimatedPrice', '')::numeric, nullif(p_payload->>'notes', '')
  ) returning id into v_lead;

  v_summary := 'New website quote request'
    || case when v_services is not null then ' — ' || v_services else '' end
    || case when nullif(p_payload->>'lawnSqft', '') is not null then ' · ' || (p_payload->>'lawnSqft') || ' ft² lawn' else '' end
    || case when nullif(p_payload->>'estimatedPrice', '') is not null then ' · est. $' || (p_payload->>'estimatedPrice') else '' end;
  insert into public.service_requests (user_id, customer_id, message, status)
    values (v_user, v_customer, v_summary, 'new');

  update public.conversations set lead_status = 'new'
    where user_id = v_user and customer_id = v_customer;
  select id into v_convo from public.conversations where user_id = v_user and customer_id = v_customer limit 1;
  update public.website_leads set conversation_id = v_convo where id = v_lead;

  return json_build_object('lead_id', v_lead, 'customer_id', v_customer);
end; $$;
grant execute on function public.submit_website_lead(text, jsonb) to anon, authenticated;
