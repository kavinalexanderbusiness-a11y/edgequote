-- Safe public quote -> acceptance -> deposit -> schedule contract.
--
-- Public forms may create/reconcile a lead and a DRAFT quote, but client-supplied
-- measurements and prices are evidence for review only. A real visit can be
-- scheduled only from a customer-accepted, still-current written quote, after any
-- configured deposit is present in the canonical payment ledger. Availability is
-- derived from the owner's explicitly confirmed rules and live EdgeHQ calendar.

alter table public.consent_changes
  add column if not exists consent_version text,
  add column if not exists consented_at timestamptz,
  add column if not exists evidence jsonb,
  add column if not exists evidence_key text;

create unique index if not exists consent_changes_evidence_key_unique
  on public.consent_changes (user_id, evidence_key)
  where evidence_key is not null;

comment on column public.consent_changes.consent_version is
  'Version of the exact public consent disclosure the customer saw.';
comment on column public.consent_changes.consented_at is
  'Customer-side acknowledgement time, bounded against server receipt time.';
comment on column public.consent_changes.evidence is
  'Bounded consent evidence. Never stores credentials or arbitrary request headers.';

create or replace function public.record_public_email_marketing_consent(
  p_token text,
  p_customer_id uuid,
  p_consent boolean,
  p_version text,
  p_consented_at timestamptz,
  p_source text
)
returns boolean
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid;
  v_email text;
  v_old boolean;
  v_version text := nullif(btrim(coalesce(p_version, '')), '');
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_key text;
begin
  -- This door can only add affirmative email-marketing consent. An unchecked or
  -- omitted box is not a withdrawal and must never erase an earlier valid opt-in.
  if p_consent is not true then return false; end if;
  if v_version is null or length(v_version) > 60 or v_source is null or length(v_source) > 120 then
    return false;
  end if;
  if p_consented_at is null
     or p_consented_at < now() - interval '24 hours'
     or p_consented_at > now() + interval '10 minutes' then
    return false;
  end if;

  select b.user_id into v_user
    from public.business_settings b
   where b.booking_token = p_token and b.booking_enabled = true;
  if v_user is null then return false; end if;

  select c.email, c.email_opt_in into v_email, v_old
    from public.customers c
   where c.id = p_customer_id and c.user_id = v_user
   for update;
  if not found or nullif(btrim(coalesce(v_email, '')), '') is null then return false; end if;

  v_key := encode(extensions.digest(
    concat_ws('|', v_user::text, p_customer_id::text, lower(v_email),
      v_version, p_consented_at::text, v_source, 'email-marketing-yes'), 'sha256'), 'hex');

  update public.customers
     set email_opt_in = true
   where id = p_customer_id and user_id = v_user and email_opt_in is distinct from true;

  insert into public.consent_changes (
    user_id, customer_id, channel, old_value, new_value, source, changed_by,
    consent_version, consented_at, evidence, evidence_key
  ) values (
    v_user, p_customer_id, 'email_marketing', v_old, true, v_source,
    'customer (website quote form)', v_version, p_consented_at,
    jsonb_build_object(
      'affirmative', true,
      'email_present', true,
      'received_at', now(),
      'form', 'free_quote'
    ),
    v_key
  ) on conflict (user_id, evidence_key) where evidence_key is not null do nothing;

  return true;
end;
$function$;

revoke all on function public.record_public_email_marketing_consent(text, uuid, boolean, text, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_public_email_marketing_consent(text, uuid, boolean, text, timestamptz, text)
  to service_role;

-- The legacy endpoint could create a scheduled visit directly from an anonymous
-- payload. Keep the function available to server-side migration tools only; no
-- browser role may bypass written quote acceptance and the deposit gate.
revoke all on function public.book_service(text, jsonb) from public, anon, authenticated;
revoke all on function public.public_availability(text, integer) from public, anon, authenticated;

-- Existing EdgeHQ instant-quote links still submit to this RPC. Preserve the
-- signature, but turn every price/measurement supplied by the browser into a
-- labelled claim in lead_meta. Canonical property measurements and quote prices
-- remain NULL until the owner reviews them in EdgeHQ.
create or replace function public.submit_booking(
  p_token text, p_name text, p_email text, p_phone text, p_address text,
  p_city text, p_province text, p_postal text, p_lat double precision,
  p_lng double precision, p_sqft numeric, p_service_type text, p_initial numeric,
  p_weekly numeric, p_biweekly numeric, p_monthly numeric, p_cadence text,
  p_notes text default null, p_hear_about text default null,
  p_referral_code text default null, p_utm jsonb default null,
  p_photos text[] default null
)
returns json
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
  v_source text; v_meta jsonb; v_photo_count int := coalesce(array_length(p_photos, 1), 0);
  v_service text;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_address), '') = '' then return null; end if;
  if coalesce(btrim(p_email), '') = '' and coalesce(btrim(p_phone), '') = '' then return null; end if;

  v_service := coalesce(
    nullif(btrim(p_service_type), ''),
    (select s.name from public.service_templates s
      where s.user_id = v_user and s.is_active and s.published_at is not null
      order by s.sort_order, s.name limit 1),
    'Service');
  v_source := coalesce(
    public.sanitize_source_input(p_hear_about),
    public.sanitize_source_input(p_utm->>'source'),
    'Online Booking');
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'hear_about', p_hear_about,
    'referral_code', p_referral_code,
    'utm', p_utm,
    'photos', to_jsonb(p_photos),
    'additional_notes', p_notes,
    'review_required', true,
    'client_claims', jsonb_build_object(
      'measurement_sqft', p_sqft,
      'lat', p_lat,
      'lng', p_lng,
      'initial_price', p_initial,
      'weekly_price', p_weekly,
      'biweekly_price', p_biweekly,
      'monthly_price', p_monthly,
      'cadence', p_cadence,
      'trusted_for_pricing', false)));

  v_customer := public.resolve_intake_customer(
    v_user, left(btrim(p_name), 200), p_email, p_phone, p_address,
    p_city, p_province, p_postal, v_source, p_notes);
  v_property := public.resolve_intake_property(
    v_user, v_customer, p_address, p_city, p_province, p_postal,
    null, null, null, null, null, null, null, null);

  -- Serialize equivalent submissions before checking for an existing review.
  -- Without this lock, two browser retries can both observe "no quote" and
  -- insert duplicates a few milliseconds apart.
  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', v_user::text, v_customer::text, coalesce(v_property::text, ''), lower(v_service)), 0));

  -- A rapid retry returns the existing open review instead of multiplying quotes.
  select q.id, q.quote_number into v_quote, v_qnum
    from public.quotes q
   where q.user_id = v_user and q.customer_id = v_customer
     and q.property_id is not distinct from v_property
     and lower(q.service_type) = lower(v_service)
     and q.status = 'draft'
     and q.created_at > now() - interval '15 minutes'
     and coalesce(q.lead_meta->>'public_booking_review', '') = 'true'
   order by q.created_at desc limit 1;

  if v_quote is null then
    perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|quote-number', 0));
    select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
      from public.quotes where user_id = v_user
       and quote_number like 'EPS-' || extract(year from now())::text || '-%';
    v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

    insert into public.quotes (
      user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status,
      measured_sqft, property_id, notes, lead_meta, price_source, pricing_config_version_id
    ) values (
      v_user, v_qnum, v_customer, left(btrim(p_name), 200), btrim(p_address), v_service,
      null, null, null, null, 'draft', null, v_property, nullif(btrim(p_notes), ''),
      v_meta || jsonb_build_object('public_booking_review', true), null, null
    ) returning id into v_quote;

    insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer,
      'New online quote request (review required) — ' || left(btrim(p_name), 80)
      || ' · ' || btrim(p_address) || ' · ' || v_service
      || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || ' · client measurement and prices were not used · draft ' || v_qnum);
  end if;

  return json_build_object(
    'quote_number', v_qnum,
    'customer_id', v_customer,
    'quote_id', v_quote,
    'state', 'review_required');
end;
$function$;

-- Turn a durable website lead into one owner-review draft. This is server-only:
-- the public caller cannot pick a tenant/customer, price, property measurement,
-- status or quote number. Replays return the same quote for the same lead.
create or replace function public.ensure_public_lead_quote(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid; v_wl public.website_leads; v_customer public.customers;
  v_property uuid; v_quote uuid; v_qnum text; v_num int; v_service text;
  v_claim jsonb; v_notes text;
begin
  select b.user_id into v_user from public.business_settings b
   where b.booking_token = p_token and b.booking_enabled = true;
  if v_user is null then return jsonb_build_object('state', 'invalid_site'); end if;

  select * into v_wl from public.website_leads wl
   where wl.id = p_lead_id and wl.user_id = v_user and wl.customer_id = p_customer_id;
  if not found then return jsonb_build_object('state', 'invalid_lead'); end if;
  select * into v_customer from public.customers c
   where c.id = p_customer_id and c.user_id = v_user;
  if not found then return jsonb_build_object('state', 'invalid_customer'); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|website-lead|' || p_lead_id::text, 0));
  select q.id, q.quote_number into v_quote, v_qnum from public.quotes q
   where q.user_id = v_user and q.customer_id = p_customer_id
     and q.lead_meta->>'website_lead_id' = p_lead_id::text
   order by q.created_at asc limit 1;
  if v_quote is not null then
    update public.website_leads
       set quote_id = v_quote
     where id = p_lead_id and user_id = v_user and customer_id = p_customer_id
       and quote_id is distinct from v_quote;
    return jsonb_build_object('state', 'review_required', 'quote_id', v_quote, 'quote_number', v_qnum);
  end if;

  v_service := coalesce(nullif(btrim(v_wl.requested_services), ''), 'Service request');
  v_claim := coalesce(v_wl.raw_submission->'client_estimate_claim', '{}'::jsonb);
  v_notes := concat_ws(E'\n\n',
    nullif(btrim(coalesce(v_wl.notes, '')), ''),
    case when v_claim <> '{}'::jsonb
      then 'Customer website estimate is an untrusted review aid only; verify measurements, scope and price before sending.' end,
    'Confirm address, route eligibility, full scope, duration, crew, costs, margin, deposit and availability before sending.');

  v_property := public.resolve_intake_property(
    v_user, p_customer_id, coalesce(nullif(btrim(v_wl.address), ''), 'Website lead'),
    v_wl.city, v_wl.province, v_wl.postal_code,
    null, null, null, null, v_wl.place_id, v_wl.maps_url, null, null);

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|quote-number', 0));
  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
    from public.quotes where user_id = v_user
     and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  insert into public.quotes (
    user_id, quote_number, customer_id, customer_name, address, service_type,
    hours, crew_size, rate, initial_price, status, property_id, notes,
    measured_sqft, price_source, pricing_config_version_id, lead_meta
  ) values (
    v_user, v_qnum, p_customer_id, left(v_customer.name, 200),
    coalesce(nullif(btrim(v_wl.address), ''), 'Website lead'), left(v_service, 500),
    0, 1, 0, null, 'draft', v_property, left(v_notes, 5000),
    null, null, null,
    jsonb_build_object(
      'website_lead_id', p_lead_id,
      'public_lead_review', true,
      'review_required', true,
      'client_estimate_claim', v_claim,
      'booking_intent', v_wl.raw_submission->>'booking_intent'))
  returning id into v_quote;

  update public.website_leads
     set quote_id = v_quote
   where id = p_lead_id and user_id = v_user and customer_id = p_customer_id;

  return jsonb_build_object('state', 'review_required', 'quote_id', v_quote, 'quote_number', v_qnum);
end;
$function$;

revoke all on function public.ensure_public_lead_quote(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_public_lead_quote(text, uuid, uuid) to service_role;

-- One server-only answer to "may this accepted quote schedule itself?".
create or replace function public.public_quote_schedule_availability(
  p_token text,
  p_quote_id uuid,
  p_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_customer uuid; v_user uuid; v_q public.quotes; v_settings public.business_settings;
  v_cfg jsonb; v_min_notice int; v_window int; v_today date; v_timezone text;
  v_basis numeric := 0; v_required numeric := 0; v_collected numeric := 0;
  v_duration int; v_extra_duration int := 0; v_travel_buffer int;
  v_extra_duration_unknown boolean := false;
  v_missing jsonb := '[]'::jsonb; v_dates jsonb; v_existing_date date;
begin
  select t.customer_id, t.user_id into v_customer, v_user
    from public.customer_portal_tokens t
   where t.token = p_token and not t.revoked;
  if v_customer is null then
    return jsonb_build_object('state', 'invalid_link', 'dates', '[]'::jsonb);
  end if;

  select * into v_q from public.quotes q
   where q.id = p_quote_id and q.customer_id = v_customer and q.user_id = v_user;
  if not found then return jsonb_build_object('state', 'invalid_quote', 'dates', '[]'::jsonb); end if;
  select j.scheduled_date into v_existing_date from public.jobs j
   where j.user_id = v_user and j.quote_id = v_q.id
     and j.status in ('scheduled', 'in_progress', 'completed')
   order by j.created_at asc limit 1;
  if v_existing_date is not null or v_q.status in ('scheduled', 'completed', 'paid') then
    return jsonb_build_object(
      'state', 'already_scheduled', 'dates', '[]'::jsonb,
      'date', v_existing_date,
      'cadence', v_q.selected_cadence,
      'recurrence_setup_required', v_q.selected_cadence in ('weekly', 'biweekly'));
  end if;
  if v_q.status <> 'accepted' then
    return jsonb_build_object('state', 'awaiting_acceptance', 'dates', '[]'::jsonb);
  end if;
  if public.quote_acceptance_is_current(v_q.id) is distinct from true then
    return jsonb_build_object('state', 'review_required', 'reason', 'quote_changed', 'dates', '[]'::jsonb);
  end if;

  select * into v_settings from public.business_settings b where b.user_id = v_user;
  if not found then
    return jsonb_build_object('state', 'review_required', 'reason', 'business_settings_missing', 'dates', '[]'::jsonb);
  end if;
  v_cfg := v_settings.module_meta->'public_quote_scheduling';
  if jsonb_typeof(v_cfg) <> 'object' or coalesce(v_cfg->>'enabled', '') <> 'true' then
    v_missing := v_missing || jsonb_build_array('Enable customer self-scheduling in EdgeHQ.');
  end if;
  if coalesce(v_cfg->>'confirmed_at', '') = '' then
    v_missing := v_missing || jsonb_build_array('Confirm the public scheduling rules in EdgeHQ.');
  end if;
  if coalesce(v_cfg->>'minimum_notice_days', '') !~ '^[0-9]{1,2}$' then
    v_missing := v_missing || jsonb_build_array('Choose the minimum booking notice in days.');
  else
    v_min_notice := (v_cfg->>'minimum_notice_days')::int;
  end if;
  if coalesce(v_cfg->>'booking_window_days', '') !~ '^[0-9]{1,2}$' then
    v_missing := v_missing || jsonb_build_array('Choose how many days customers may book ahead.');
  else
    v_window := (v_cfg->>'booking_window_days')::int;
  end if;
  if coalesce(v_cfg->>'travel_buffer_minutes_per_visit', '') !~ '^[0-9]{1,3}$' then
    v_missing := v_missing || jsonb_build_array('Choose the travel and setup buffer per visit.');
  else
    v_travel_buffer := (v_cfg->>'travel_buffer_minutes_per_visit')::int;
  end if;
  if coalesce(array_length(v_settings.preferred_work_days, 1), 0) = 0 then
    v_missing := v_missing || jsonb_build_array('Choose the weekdays customers may book.');
  end if;
  if coalesce(v_settings.daily_capacity_hours, 0) <= 0 or coalesce(v_settings.default_crew_size, 0) <= 0 then
    v_missing := v_missing || jsonb_build_array('Set daily capacity and the default crew size.');
  end if;
  if v_q.property_id is null
     or coalesce(v_q.lead_meta->>'route_eligibility', '') <> 'approved'
     or coalesce(v_q.lead_meta->>'route_eligibility_approved_at', '') = '' then
    v_missing := v_missing || jsonb_build_array('Approve this service address and route eligibility on the quote.');
  end if;
  select coalesce(sum(qs.est_minutes), 0)::int,
         coalesce(bool_or(qs.est_minutes is null or qs.est_minutes <= 0), false)
    into v_extra_duration, v_extra_duration_unknown
    from public.quote_services qs
   where qs.user_id = v_user and qs.quote_id = v_q.id
     and qs.id is distinct from (
       select first_qs.id from public.quote_services first_qs
        where first_qs.user_id = v_user and first_qs.quote_id = v_q.id
        order by first_qs.sort_order, first_qs.created_at, first_qs.id limit 1);
  if coalesce(v_q.hours, 0) <= 0 or coalesce(v_q.crew_size, 0) <= 0
     or coalesce(v_q.lead_meta->>'scheduling_inputs_confirmed_at', '') = '' then
    v_missing := v_missing || jsonb_build_array('Set and confirm the quote duration and crew size.');
  end if;
  if v_extra_duration_unknown then
    v_missing := v_missing || jsonb_build_array('Set the duration for every additional quoted service.');
  end if;
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('state', 'review_required', 'missing', v_missing, 'dates', '[]'::jsonb);
  end if;
  if v_min_notice < 0 or v_min_notice > 30 or v_window < 1 or v_window > 60
     or v_travel_buffer < 0 or v_travel_buffer > 240 then
    return jsonb_build_object('state', 'review_required', 'reason', 'booking_rules_invalid', 'dates', '[]'::jsonb);
  end if;

  v_basis := case
    when coalesce(v_q.accepted_price, 0) > 0 then round(v_q.accepted_price, 2)
    when coalesce(v_q.total, 0) > 0 then round(v_q.total, 2)
    else 0 end;
  if v_basis <= 0 then
    return jsonb_build_object('state', 'review_required', 'reason', 'written_price_missing', 'dates', '[]'::jsonb);
  end if;
  if v_q.deposit_type is not null and (
       v_q.deposit_value is null or v_q.deposit_value <= 0
       or v_q.deposit_type not in ('percent', 'fixed')
       or (v_q.deposit_type = 'percent' and v_q.deposit_value > 100)) then
    return jsonb_build_object('state', 'review_required', 'reason', 'deposit_rule_invalid', 'dates', '[]'::jsonb);
  end if;
  if v_q.deposit_type = 'percent' then
    v_required := round(v_basis * v_q.deposit_value / 100, 2);
  elsif v_q.deposit_type = 'fixed' then
    v_required := case when v_basis > 0 then least(v_q.deposit_value, v_basis) else v_q.deposit_value end;
  end if;
  select coalesce(sum(p.amount), 0) into v_collected
    from public.payments p
   where p.user_id = v_user and p.quote_id = v_q.id
     and p.kind = 'payment' and p.status = 'paid' and p.provider is distinct from 'credit';
  if v_required > 0 and v_collected + 0.005 < v_required then
    return jsonb_build_object(
      'state', 'awaiting_deposit',
      'deposit_remaining', greatest(round(v_required - v_collected, 2), 0),
      'dates', '[]'::jsonb);
  end if;

  v_timezone := coalesce(nullif(v_settings.timezone, ''), 'America/Edmonton');
  if not exists (select 1 from pg_timezone_names where name = v_timezone) then
    return jsonb_build_object('state', 'review_required', 'reason', 'timezone_invalid', 'dates', '[]'::jsonb);
  end if;
  v_today := (now() at time zone v_timezone)::date;
  -- quotes.hours is elapsed on-site time. Capacity has two dimensions: the
  -- serial route clock and person-minutes. Both must fit, with the owner-chosen
  -- travel/setup buffer charged to every visit.
  v_duration := round(v_q.hours * 60)::int + v_extra_duration;
  v_window := least(v_window, greatest(coalesce(p_days, v_window), 1), 60);

  select coalesce(jsonb_agg(jsonb_build_object('date', candidate_date) order by candidate_date), '[]'::jsonb)
    into v_dates
    from (
      select g.d::date as candidate_date
        from generate_series(
          v_today + v_min_notice,
          v_today + v_window,
          interval '1 day') g(d)
        left join public.day_statuses ds
          on ds.user_id = v_user and ds.date = g.d::date
       where extract(dow from g.d)::int = any(v_settings.preferred_work_days)
         and coalesce(ds.blocks, false) = false
         -- A partial day override must have both endpoints; malformed/half-set
         -- overrides are uncertainty, not public availability.
         and not ((ds.starts_at is null) <> (ds.ends_at is null))
         and not exists (
           select 1 from public.jobs bad
            where bad.user_id = v_user and bad.scheduled_date = g.d::date
              and bad.status in ('scheduled', 'in_progress')
              and (bad.duration_minutes is null or bad.crew_size is null or bad.crew_size <= 0))
         and not exists (
           select 1 from public.schedule_items bads
            where bads.user_id = v_user and bads.scheduled_date = g.d::date
              and bads.status = 'scheduled' and bads.duration_minutes is null)
         and coalesce(ds.crew_size, v_settings.default_crew_size) >= v_q.crew_size
         -- Serial route clock. Conservatively treat visits as one route rather
         -- than implying parallel crews the owner has not configured.
         and (
           case
             when ds.starts_at is not null and ds.ends_at is not null and ds.ends_at > ds.starts_at
               then floor(extract(epoch from (ds.ends_at - ds.starts_at)) / 60)
             else round((v_settings.daily_capacity_hours / v_settings.default_crew_size) * 60)
           end
           - coalesce((select sum(j.duration_minutes + v_travel_buffer)
                         from public.jobs j
                        where j.user_id = v_user and j.scheduled_date = g.d::date
                          and j.status in ('scheduled', 'in_progress')), 0)
           - coalesce((select sum(si.duration_minutes)
                         from public.schedule_items si
                        where si.user_id = v_user and si.scheduled_date = g.d::date
                          and si.status = 'scheduled'), 0)
         ) >= v_duration + v_travel_buffer
         -- Person-minute capacity. A two-person visit consumes twice the labour
         -- even though it occupies one elapsed-time window.
         and (
           (case
             when ds.starts_at is not null and ds.ends_at is not null and ds.ends_at > ds.starts_at
               then floor(extract(epoch from (ds.ends_at - ds.starts_at)) / 60)
                    * coalesce(ds.crew_size, v_settings.default_crew_size)
             when ds.crew_size is not null
               then round((v_settings.daily_capacity_hours / v_settings.default_crew_size)
                    * ds.crew_size * 60)
             else round(v_settings.daily_capacity_hours * 60)
           end)
           - coalesce((select sum((j.duration_minutes + v_travel_buffer) * j.crew_size)
                         from public.jobs j
                        where j.user_id = v_user and j.scheduled_date = g.d::date
                          and j.status in ('scheduled', 'in_progress')), 0)
           -- Schedule items have no crew column. Charge one worker rather than
           -- pretending they are free; an unknown duration already fails closed.
           - coalesce((select sum(si.duration_minutes)
                         from public.schedule_items si
                        where si.user_id = v_user and si.scheduled_date = g.d::date
                          and si.status = 'scheduled'), 0)
         ) >= (v_duration + v_travel_buffer) * v_q.crew_size
    ) available_days;

  return jsonb_build_object(
    'state', case when jsonb_array_length(v_dates) > 0 then 'ready' else 'no_dates' end,
    'dates', v_dates);
end;
$function$;

revoke all on function public.public_quote_schedule_availability(text, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.public_quote_schedule_availability(text, uuid, integer)
  to service_role;

create or replace function public.portal_schedule_accepted_quote(
  p_token text,
  p_quote_id uuid,
  p_date date
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_customer uuid; v_user uuid; v_q public.quotes; v_avail jsonb; v_job uuid; v_existing_date date;
  v_extra_duration int := 0; v_duration int; v_price numeric;
begin
  select t.customer_id, t.user_id into v_customer, v_user
    from public.customer_portal_tokens t
   where t.token = p_token and not t.revoked;
  if v_customer is null then return jsonb_build_object('state', 'invalid_link'); end if;
  if p_date is null then return jsonb_build_object('state', 'invalid_date'); end if;

  -- Serialize all public booking attempts for this tenant/date. The quote row lock
  -- separately makes retries of the same quote idempotent.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|' || p_date::text, 0));
  select * into v_q from public.quotes q
   where q.id = p_quote_id and q.customer_id = v_customer and q.user_id = v_user
   for update;
  if not found then return jsonb_build_object('state', 'invalid_quote'); end if;

  select j.id, j.scheduled_date into v_job, v_existing_date from public.jobs j
   where j.user_id = v_user and j.quote_id = v_q.id
     and j.status in ('scheduled', 'in_progress', 'completed')
   order by j.created_at asc limit 1;
  if v_job is not null then
    return jsonb_build_object(
      'state', 'already_scheduled', 'job_id', v_job,
      'date', v_existing_date,
      'cadence', v_q.selected_cadence,
      'recurrence_setup_required', v_q.selected_cadence in ('weekly', 'biweekly'));
  end if;

  v_avail := public.public_quote_schedule_availability(p_token, p_quote_id, 60);
  if coalesce(v_avail->>'state', '') <> 'ready'
     or not exists (
       select 1 from jsonb_array_elements(coalesce(v_avail->'dates', '[]'::jsonb)) d
        where d->>'date' = p_date::text) then
    return v_avail || jsonb_build_object('selected_date', p_date);
  end if;

  select coalesce(sum(qs.est_minutes), 0)::int into v_extra_duration
    from public.quote_services qs
   where qs.user_id = v_user and qs.quote_id = v_q.id
     and qs.id is distinct from (
       select first_qs.id from public.quote_services first_qs
        where first_qs.user_id = v_user and first_qs.quote_id = v_q.id
        order by first_qs.sort_order, first_qs.created_at, first_qs.id limit 1);
  v_duration := round(v_q.hours * 60)::int + v_extra_duration;
  v_price := case when coalesce(v_q.accepted_price, 0) > 0
    then round(v_q.accepted_price, 2) else round(v_q.total, 2) end;

  insert into public.jobs (
    user_id, customer_id, property_id, quote_id, title, service_type,
    scheduled_date, duration_minutes, crew_size, price, status, notes, is_initial_visit
  ) values (
    v_user, v_customer, v_q.property_id, v_q.id,
    left(v_q.service_type || ' — ' || v_q.customer_name, 200), v_q.service_type,
    p_date, v_duration, v_q.crew_size, v_price, 'scheduled', v_q.notes,
    not exists (select 1 from public.jobs prior where prior.user_id = v_user
                and prior.customer_id = v_customer and prior.status = 'completed')
  ) returning id into v_job;

  update public.quotes set status = 'scheduled'
   where id = v_q.id and user_id = v_user and status = 'accepted';
  if not found then raise exception 'quote state changed while scheduling'; end if;

  -- Public date selection books the first live-capacity-checked visit. Creating
  -- an entire recurring series here would silently place later visits without
  -- checking their dates. Keep that operational decision visible to the owner.
  if v_q.selected_cadence in ('weekly', 'biweekly') then
    insert into public.service_requests(user_id, customer_id, message)
    values (
      v_user, v_customer,
      'Recurring setup required: first ' || v_q.selected_cadence || ' visit for quote '
        || v_q.quote_number || ' is booked on ' || p_date::text
        || '; create the remaining route-safe recurrence before the next visit.'
    );
    update public.quotes set lead_meta = coalesce(lead_meta, '{}'::jsonb)
      || jsonb_build_object('recurrence_setup_required', true, 'first_visit_scheduled_at', now())
     where id = v_q.id and user_id = v_user;
  end if;

  return jsonb_build_object(
    'state', 'scheduled', 'job_id', v_job, 'date', p_date,
    'cadence', v_q.selected_cadence,
    'recurrence_setup_required', v_q.selected_cadence in ('weekly', 'biweekly'));
end;
$function$;

revoke all on function public.portal_schedule_accepted_quote(text, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.portal_schedule_accepted_quote(text, uuid, date)
  to service_role;

-- Owner-facing configuration door. Keeping this as one narrow RPC avoids a
-- settings tab replacing the rest of module_meta with a stale browser copy.
create or replace function public.configure_public_quote_scheduling(
  p_enabled boolean,
  p_minimum_notice_days integer,
  p_booking_window_days integer,
  p_travel_buffer_minutes integer,
  p_default_crew_size integer
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_cfg jsonb;
begin
  if v_user is null then
    return jsonb_build_object('state', 'not_signed_in');
  end if;
  if p_minimum_notice_days is null or p_minimum_notice_days < 0 or p_minimum_notice_days > 30
     or p_booking_window_days is null or p_booking_window_days < 1 or p_booking_window_days > 60
     or p_travel_buffer_minutes is null or p_travel_buffer_minutes < 0 or p_travel_buffer_minutes > 240
     or p_default_crew_size is null or p_default_crew_size < 1 or p_default_crew_size > 50 then
    return jsonb_build_object('state', 'invalid_rules');
  end if;

  v_cfg := jsonb_build_object(
    'enabled', coalesce(p_enabled, false),
    'confirmed_at', now(),
    'minimum_notice_days', p_minimum_notice_days,
    'booking_window_days', p_booking_window_days,
    'travel_buffer_minutes_per_visit', p_travel_buffer_minutes,
    'confirmed_by', v_user);

  update public.business_settings
     set default_crew_size = p_default_crew_size,
         module_meta = jsonb_set(coalesce(module_meta, '{}'::jsonb),
           '{public_quote_scheduling}', v_cfg, true)
   where user_id = v_user;
  if not found then
    return jsonb_build_object('state', 'settings_missing');
  end if;
  return jsonb_build_object('state', 'saved', 'config', v_cfg);
end;
$function$;

revoke all on function public.configure_public_quote_scheduling(boolean, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_public_quote_scheduling(boolean, integer, integer, integer, integer)
  to authenticated;

-- One explicit owner action confirms the facts that the public scheduler is
-- allowed to use for this quote. It does not accept/send the quote or schedule a
-- visit. Missing facts are returned to the UI instead of being guessed.
create or replace function public.set_public_quote_scheduling_approval(
  p_quote_id uuid,
  p_approved boolean
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_q public.quotes;
  v_bad_extra boolean := false;
  v_meta jsonb;
  v_missing jsonb := '[]'::jsonb;
begin
  if v_user is null then return jsonb_build_object('state', 'not_signed_in'); end if;
  select * into v_q from public.quotes q
   where q.id = p_quote_id and q.user_id = v_user for update;
  if not found then return jsonb_build_object('state', 'not_found'); end if;

  v_meta := case when jsonb_typeof(v_q.lead_meta) = 'object'
    then v_q.lead_meta else '{}'::jsonb end;
  if coalesce(p_approved, false) is false then
    update public.quotes
       set lead_meta = (v_meta
         - 'route_eligibility_approved_at'
         - 'route_eligibility_approved_by'
         - 'scheduling_inputs_confirmed_at'
         - 'scheduling_inputs_confirmed_by')
         || jsonb_build_object('route_eligibility', 'pending')
     where id = v_q.id and user_id = v_user;
    return jsonb_build_object('state', 'review_required');
  end if;

  if v_q.property_id is null then
    v_missing := v_missing || jsonb_build_array('Link a verified property.');
  end if;
  if coalesce(nullif(btrim(v_q.address), ''), '') = '' then
    v_missing := v_missing || jsonb_build_array('Add the service address.');
  end if;
  if coalesce(v_q.hours, 0) <= 0 then
    v_missing := v_missing || jsonb_build_array('Set a positive on-site duration.');
  end if;
  if coalesce(v_q.crew_size, 0) <= 0 then
    v_missing := v_missing || jsonb_build_array('Set a positive crew size.');
  end if;
  select exists (
    select 1 from (
      select qs.est_minutes,
             row_number() over (order by qs.sort_order, qs.created_at, qs.id) as rn
        from public.quote_services qs
       where qs.user_id = v_user and qs.quote_id = v_q.id
    ) lines where lines.rn > 1 and coalesce(lines.est_minutes, 0) <= 0
  ) into v_bad_extra;
  if v_bad_extra then
    v_missing := v_missing || jsonb_build_array('Set a duration for every additional service.');
  end if;
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('state', 'review_required', 'missing', v_missing);
  end if;

  update public.quotes
     set lead_meta = v_meta || jsonb_build_object(
       'route_eligibility', 'approved',
       'route_eligibility_approved_at', now(),
       'route_eligibility_approved_by', v_user,
       'scheduling_inputs_confirmed_at', now(),
       'scheduling_inputs_confirmed_by', v_user)
   where id = v_q.id and user_id = v_user;
  return jsonb_build_object('state', 'approved');
end;
$function$;

revoke all on function public.set_public_quote_scheduling_approval(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_public_quote_scheduling_approval(uuid, boolean)
  to authenticated;

-- A later edit invalidates the exact approval it changed. This prevents an old
-- checkbox from silently blessing a new property, duration, crew, or line item.
create or replace function public.clear_quote_public_schedule_approval()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
begin
  if new.property_id is distinct from old.property_id or new.address is distinct from old.address then
    new.lead_meta := (case when jsonb_typeof(new.lead_meta) = 'object' then new.lead_meta else '{}'::jsonb end)
      - 'route_eligibility_approved_at' - 'route_eligibility_approved_by'
      - 'scheduling_inputs_confirmed_at' - 'scheduling_inputs_confirmed_by';
    new.lead_meta := new.lead_meta || jsonb_build_object('route_eligibility', 'pending');
  elsif new.service_type is distinct from old.service_type
     or new.hours is distinct from old.hours
     or new.crew_size is distinct from old.crew_size then
    new.lead_meta := (case when jsonb_typeof(new.lead_meta) = 'object' then new.lead_meta else '{}'::jsonb end)
      - 'scheduling_inputs_confirmed_at' - 'scheduling_inputs_confirmed_by';
  end if;
  return new;
end;
$function$;

drop trigger if exists quotes_clear_public_schedule_approval on public.quotes;
create trigger quotes_clear_public_schedule_approval
before update of property_id, address, service_type, hours, crew_size on public.quotes
for each row execute function public.clear_quote_public_schedule_approval();

create or replace function public.clear_quote_public_schedule_approval_for_line()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_quote_id uuid;
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_quote_id := old.quote_id;
    v_user := old.user_id;
  else
    v_quote_id := new.quote_id;
    v_user := new.user_id;
  end if;
  update public.quotes q
     set lead_meta = (case when jsonb_typeof(q.lead_meta) = 'object' then q.lead_meta else '{}'::jsonb end)
       - 'scheduling_inputs_confirmed_at' - 'scheduling_inputs_confirmed_by'
   where q.id = v_quote_id and q.user_id = v_user;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

drop trigger if exists quote_services_clear_public_schedule_approval on public.quote_services;
create trigger quote_services_clear_public_schedule_approval
after insert or update or delete on public.quote_services
for each row execute function public.clear_quote_public_schedule_approval_for_line();
