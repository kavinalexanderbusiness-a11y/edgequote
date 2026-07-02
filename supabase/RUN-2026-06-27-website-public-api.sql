-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Website ↔ EdgeQuote integration: public read APIs + smart booking.
-- Idempotent (create or replace). Additive — no schema changes, only functions.
-- ════════════════════════════════════════════════════════════
--
-- Makes EdgeQuote the single source of truth for the public website. Three anon,
-- token-keyed SECURITY DEFINER functions (gated on booking_enabled, same booking_token
-- the lead intake already uses):
--   public_services(token)      → branding + the owner's ACTIVE service templates (the
--                                 website's service list + pricing — no duplication).
--   public_availability(token)  → the next bookable days from the owner's preferred work
--                                 days + daily capacity − jobs already on the calendar.
--   book_service(token, payload) → de-dupes the customer (returning customers recognised
--                                 automatically), creates the property, and EITHER books a
--                                 job (a real date + service was chosen) OR raises a 'sent'
--                                 quote, then notifies the owner (→ Messages thread).
-- The existing /api/website-lead + Formspree intake stay as the fallback.


-- (1) Public services + pricing — drives the website's service list & prices.
create or replace function public.public_services(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; result json;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  select json_build_object(
    'business', (select to_json(b) from (
      select company_name, owner_name, logo_url, phone, email_primary, website, base_address,
             coalesce(gst_percent, 0) as gst_percent
      from public.business_settings where user_id = v_user) b),
    'services', (select coalesce(json_agg(
        json_build_object(
          'id', id, 'name', name, 'category', category,
          'description', default_description, 'default_rate', default_rate,
          'pricing_display_type', pricing_display_type
        ) order by sort_order, name), '[]'::json)
      from public.service_templates where user_id = v_user and is_active = true)
  ) into result;
  return result;
end; $$;
grant execute on function public.public_services(text) to anon, authenticated;


-- (2) Public availability — next bookable days from preferred work days + capacity.
create or replace function public.public_availability(p_token text, p_days int default 14)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_days int; v_cap_min numeric; v_pref int[];
begin
  select user_id, coalesce(daily_capacity_hours, 8) * 60, coalesce(preferred_work_days, '{5,6,0}')
    into v_user, v_cap_min, v_pref
    from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  v_days := least(greatest(coalesce(p_days, 14), 1), 60);
  return (
    select coalesce(json_agg(json_build_object(
      'date', d::date,
      'weekday', trim(to_char(d, 'Dy')),
      'available', booked_min < v_cap_min,
      'remaining_minutes', greatest(v_cap_min - booked_min, 0)::int
    ) order by d), '[]'::json)
    from (
      select g.d, coalesce((
        select sum(coalesce(j.duration_minutes, j.actual_minutes, 45))
        from public.jobs j
        where j.user_id = v_user and j.scheduled_date = g.d::date and j.status in ('scheduled', 'in_progress')
      ), 0) as booked_min
      from generate_series(current_date + 1, current_date + v_days, interval '1 day') g(d)
      where (extract(dow from g.d))::int = any(v_pref)
    ) days
  );
end; $$;
grant execute on function public.public_availability(text, int) to anon, authenticated;


-- (3) Smart booking — de-dupe customer, create property, book a job or raise a quote.
create or replace function public.book_service(p_token text, p_payload jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_returning boolean := false;
  v_name text; v_email text; v_phone text; v_digits text;
  v_address text; v_city text; v_postal text; v_province text;
  v_service text; v_sqft numeric; v_date date; v_notes text;
  v_rate numeric; v_job uuid; v_quote uuid; v_num int; v_qnum text := null; v_mode text;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;

  -- Light abuse guard (per-business, last hour) — mirrors the lead intake.
  if (select count(*) from public.service_requests where user_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    return json_build_object('error', 'rate_limited');
  end if;

  v_name    := nullif(trim(coalesce(p_payload->>'name', p_payload->>'fullName', concat_ws(' ', p_payload->>'firstName', p_payload->>'lastName'))), '');
  v_email   := lower(nullif(trim(coalesce(p_payload->>'email', '')), ''));
  v_phone   := nullif(trim(coalesce(p_payload->>'phone', '')), '');
  v_address := nullif(trim(coalesce(p_payload->>'address', p_payload->>'serviceAddress', '')), '');
  v_city    := nullif(trim(coalesce(p_payload->>'city', '')), '');
  v_postal  := nullif(trim(coalesce(p_payload->>'postalCode', p_payload->>'postal_code', '')), '');
  v_province := coalesce(nullif(trim(p_payload->>'province', ''), ''), 'AB');
  v_service := nullif(trim(coalesce(p_payload->>'serviceType', p_payload->>'service', p_payload->>'requestedServices', '')), '');
  v_notes   := nullif(trim(coalesce(p_payload->>'notes', p_payload->>'message', '')), '');
  begin v_sqft := nullif((p_payload->>'sqft')::numeric, 0); exception when others then v_sqft := null; end;
  begin v_date := (p_payload->>'requestedDate')::date; exception when others then v_date := null; end;
  if v_name is null then return json_build_object('error', 'missing_name'); end if;

  -- DEDUP customer (phone last-10 → email → address) → returning recognition.
  v_digits := right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10);
  if length(v_digits) = 10 then
    select id into v_customer from public.customers
      where user_id = v_user and phone is not null and right(regexp_replace(phone, '\D', '', 'g'), 10) = v_digits
      order by created_at desc limit 1;
  end if;
  if v_customer is null and v_email is not null then
    select id into v_customer from public.customers where user_id = v_user and lower(coalesce(email, '')) = v_email order by created_at desc limit 1;
  end if;
  if v_customer is null and v_address is not null then
    select id into v_customer from public.customers where user_id = v_user and lower(coalesce(address, '')) = lower(v_address) order by created_at desc limit 1;
  end if;

  if v_customer is not null then
    v_returning := true;
    update public.customers set phone = coalesce(phone, v_phone), email = coalesce(email, v_email) where id = v_customer;
  else
    insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source)
      values (v_user, left(v_name, 200), v_email, v_phone, v_address, v_city, v_province, v_postal, 'Online Booking')
      returning id into v_customer;
  end if;

  -- Property (de-dupe by address under this customer), only when an address is given.
  if v_address is not null then
    select id into v_prop from public.properties where customer_id = v_customer and lower(coalesce(address, '')) = lower(v_address) limit 1;
    if v_prop is null then
      insert into public.properties (user_id, customer_id, address, city, province, postal_code, lawn_sqft, is_primary)
        values (v_user, v_customer, v_address, v_city, v_province, v_postal, v_sqft, not exists (select 1 from public.properties where customer_id = v_customer))
        returning id into v_prop;
    end if;
  end if;

  -- Price comes from a matching active service template (single source of truth).
  if v_service is not null then
    select default_rate into v_rate from public.service_templates
      where user_id = v_user and lower(name) = lower(v_service) and is_active = true order by sort_order limit 1;
  end if;

  -- A real future date + a service → book a job. Otherwise raise a 'sent' quote.
  if v_date is not null and v_date >= current_date and v_service is not null then
    v_mode := 'booked';
    insert into public.jobs (user_id, customer_id, property_id, title, service_type, scheduled_date, status, price, notes, is_initial_visit)
      values (v_user, v_customer, v_prop, left(v_service, 120), v_service, v_date, 'scheduled', v_rate, v_notes, not v_returning)
      returning id into v_job;
  else
    v_mode := 'quote';
    select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
      from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
    v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');
    insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type, initial_price, status, measured_sqft, property_id, sent_at)
      values (v_user, v_qnum, v_customer, left(v_name, 200), v_address, coalesce(v_service, 'Lawn Mowing'), v_rate, 'sent', v_sqft, v_prop, now())
      returning id into v_quote;
  end if;

  -- Notify the owner — the trigger threads this into Messages (the customer conversation).
  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer,
      case when v_mode = 'booked'
        then 'New online booking — ' || left(v_name, 80) || ' · ' || coalesce(v_service, 'service') || ' on ' || to_char(v_date, 'Mon DD') || coalesce(' · ' || v_address, '')
        else 'New quote request — ' || left(v_name, 80) || coalesce(' · ' || v_service, '') || coalesce(' · ' || v_address, '') end);

  return json_build_object('ok', true, 'mode', v_mode, 'returning', v_returning,
    'customer_id', v_customer, 'job_id', v_job, 'quote_id', v_quote, 'quote_number', v_qnum);
end; $$;
grant execute on function public.book_service(text, jsonb) to anon, authenticated;