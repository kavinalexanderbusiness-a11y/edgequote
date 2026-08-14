-- ADR-002 · Pricing Configuration Provenance · MIGRATION 3: the two SQL quote writers
--
-- Both are SECURITY DEFINER, so both can call public.ensure_pricing_config_version
-- directly — the SAME engine the dashboard reaches by RPC. One implementation, two
-- callers. (The anonymous booking client cannot read pricing_config_versions under RLS,
-- which is exactly why the engine lives in SQL rather than in TypeScript.)
--
-- ⚠️ THE TWO WRITERS ARE NOT THE SAME, and must not be recorded as if they were:
--
--   submit_booking  — prices in TypeScript (BookingClient calls pricingPackage with the
--                     live config) and passes them as arguments. Engine-priced, so it
--                     records price_source='engine' AND a config version.
--
--   book_service    — prices FLAT from service_templates.default_rate and never reads
--                     pricing config at all. It captures v_sqft, stores it, and ignores
--                     it: $45 flat where the engine says $75 at 1,700 ft² and $100 at
--                     3,000 ft². Recording a config version against it would be a LIE —
--                     it would claim a rate card explained a number that rate card never
--                     touched. It records price_source='template_rate' and NO version.
--
-- That distinction is the whole reason `price_source` exists. ⛔ Do not "fix" the
-- asymmetry by stamping a version on book_service. Its pricing gap is a REAL, separate
-- defect (tracked in the validation report); ADR-002's job is to record truthfully what
-- each writer actually did, not to paper over the difference. Booking is its own
-- redesign project.

begin;

-- ── submit_booking — engine-priced, records a version ────────────────────────
create or replace function public.submit_booking(p_token text, p_name text, p_email text, p_phone text, p_address text, p_city text, p_province text, p_postal text, p_lat double precision, p_lng double precision, p_sqft numeric, p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric, p_cadence text, p_notes text DEFAULT NULL::text, p_hear_about text DEFAULT NULL::text, p_referral_code text DEFAULT NULL::text, p_utm jsonb DEFAULT NULL::jsonb, p_photos text[] DEFAULT NULL::text[])
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

  -- The service the caller asked for; else the owner's primary offering from their
  -- OWN catalog; else a neutral label. Never a trade this platform picked.
  v_service := coalesce(
    nullif(trim(p_service_type), ''),
    (select s.name from public.service_templates s
      where s.user_id = v_user and s.is_active
      order by s.sort_order, s.name limit 1),
    'Service');

  -- ADR-002: the prices below were computed by the engine (client-side, from this
  -- owner's live pricing config) and handed to us as arguments. Record WHICH config,
  -- so the quote can be reproduced. Not fail-closed here, deliberately: this is a
  -- public booking funnel and a lead is worth more than a provenance row. A null
  -- version degrades to price_source = null (unknown), which reads honestly as
  -- "not recorded" rather than falsely as "priced by config X".
  v_cfg := public.ensure_pricing_config_version(v_user);

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
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, notes, lead_meta,
      price_source, pricing_config_version_id)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, v_service,
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'draft', nullif(p_sqft, 0), v_property, nullif(trim(p_notes), ''), v_meta,
      -- 'engine' only when we can NAME the config — the CHECK constraint
      -- quotes_engine_price_needs_config enforces that pairing anyway.
      case when v_cfg is not null then 'engine' else null end, v_cfg)
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking (review) — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time')
      || ' · via ' || v_source || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || case when nullif(trim(p_referral_code), '') is not null then ' · ref:' || p_referral_code else '' end || ' · draft ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $function$;

-- ── book_service — template-rate priced, records NO version ──────────────────
create or replace function public.book_service(p_token text, p_payload jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_returning boolean := false;
  v_name text; v_email text; v_phone text; v_digits text;
  v_address text; v_city text; v_postal text; v_province text;
  v_service text; v_sqft numeric; v_date date; v_notes text;
  v_rate numeric; v_job uuid; v_quote uuid; v_num int; v_qnum text := null; v_mode text;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if (select count(*) from public.service_requests where user_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    return json_build_object('error','rate_limited'); end if;

  v_name    := nullif(trim(coalesce(p_payload->>'name', p_payload->>'fullName', concat_ws(' ', p_payload->>'firstName', p_payload->>'lastName'))), '');
  v_email   := lower(nullif(trim(coalesce(p_payload->>'email','')), ''));
  v_phone   := nullif(trim(coalesce(p_payload->>'phone','')), '');
  v_address := nullif(trim(coalesce(p_payload->>'address', p_payload->>'serviceAddress','')), '');
  v_city    := nullif(trim(coalesce(p_payload->>'city','')), '');
  v_postal  := nullif(trim(coalesce(p_payload->>'postalCode', p_payload->>'postal_code','')), '');
  v_province := coalesce(nullif(trim(p_payload->>'province',''),''), 'AB');
  v_service := nullif(trim(coalesce(p_payload->>'serviceType', p_payload->>'service', p_payload->>'requestedServices','')), '');
  v_notes   := nullif(trim(coalesce(p_payload->>'notes', p_payload->>'message','')), '');
  begin v_sqft := nullif((p_payload->>'sqft')::numeric, 0); exception when others then v_sqft := null; end;
  begin v_date := (p_payload->>'requestedDate')::date; exception when others then v_date := null; end;
  if v_name is null then return json_build_object('error','missing_name'); end if;

  v_digits := right(regexp_replace(coalesce(v_phone,''),'\D','','g'),10);
  if length(v_digits)=10 then select id into v_customer from public.customers where user_id=v_user and phone is not null and right(regexp_replace(phone,'\D','','g'),10)=v_digits order by created_at desc limit 1; end if;
  if v_customer is null and v_email is not null then select id into v_customer from public.customers where user_id=v_user and lower(coalesce(email,''))=v_email order by created_at desc limit 1; end if;
  if v_customer is null and v_address is not null then select id into v_customer from public.customers where user_id=v_user and lower(coalesce(address,''))=lower(v_address) order by created_at desc limit 1; end if;

  if v_customer is not null then
    v_returning := true;
    update public.customers set phone=coalesce(phone,v_phone), email=coalesce(email,v_email) where id=v_customer;
  else
    insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source)
      values (v_user, left(v_name,200), v_email, v_phone, v_address, v_city, v_province, v_postal, 'Online Booking') returning id into v_customer;
  end if;

  if v_address is not null then
    select id into v_prop from public.properties where customer_id=v_customer and lower(coalesce(address,''))=lower(v_address) limit 1;
    if v_prop is null then
      insert into public.properties (user_id, customer_id, address, city, province, postal_code, lawn_sqft, is_primary)
        values (v_user, v_customer, v_address, v_city, v_province, v_postal, v_sqft, not exists(select 1 from public.properties where customer_id=v_customer)) returning id into v_prop;
    end if;
  end if;

  if v_service is not null then select default_rate into v_rate from public.service_templates where user_id=v_user and lower(name)=lower(v_service) and is_active=true order by sort_order limit 1; end if;

  if v_date is not null and v_date >= current_date and v_service is not null then
    v_mode := 'booked';
    insert into public.jobs (user_id, customer_id, property_id, title, service_type, scheduled_date, status, price, notes, is_initial_visit)
      values (v_user, v_customer, v_prop, left(v_service,120), v_service, v_date, 'scheduled', v_rate, v_notes, not v_returning) returning id into v_job;
  else
    v_mode := 'quote';
    select coalesce(max((regexp_match(quote_number,'([0-9]+)$'))[1]::int),0)+1 into v_num from public.quotes where user_id=v_user and quote_number like 'EPS-'||extract(year from now())::text||'-%';
    v_qnum := 'EPS-'||extract(year from now())::text||'-'||lpad(v_num::text,4,'0');
    -- ADR-002: price_source='template_rate' and NO config version, because that is the
    -- truth — this price came from service_templates.default_rate and the pricing
    -- config never touched it. resolveQuoteProvenance() reads this as
    -- 'not_engine_priced' and says so, instead of implying a rate card it never used.
    insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type, initial_price, status, measured_sqft, property_id, sent_at, price_source)
      values (v_user, v_qnum, v_customer, left(v_name,200), v_address, coalesce(v_service,'Lawn Mowing'), v_rate, 'sent', v_sqft, v_prop, now(), 'template_rate') returning id into v_quote;
  end if;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, case when v_mode='booked'
      then 'New online booking — '||left(v_name,80)||' · '||coalesce(v_service,'service')||' on '||to_char(v_date,'Mon DD')||coalesce(' · '||v_address,'')
      else 'New quote request — '||left(v_name,80)||coalesce(' · '||v_service,'')||coalesce(' · '||v_address,'') end);

  return json_build_object('ok',true,'mode',v_mode,'returning',v_returning,'customer_id',v_customer,'job_id',v_job,'quote_id',v_quote,'quote_number',v_qnum);
end; $function$;

commit;
