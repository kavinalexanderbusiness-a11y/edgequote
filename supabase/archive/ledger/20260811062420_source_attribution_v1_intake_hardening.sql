-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811062420
--   name    : source_attribution_v1_intake_hardening
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Lead source + conversion attribution V1 — intake hardening.
-- Idempotent: every statement is CREATE OR REPLACE. No DDL on any table, no
-- column added, no data rewritten, no signature changed, no grant changed.

-- 1. The sanitiser. Mirrors sanitizeSourceInput() in src/lib/attribution.ts:
-- strip control characters, collapse whitespace, trim, bound to 60 chars,
-- empty -> null. Pure text in / text out: no table access, so SECURITY INVOKER
-- (the default) is correct.
create or replace function public.sanitize_source_input(p_raw text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(
    btrim(left(
      btrim(regexp_replace(regexp_replace(coalesce(p_raw, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')),
      60)),
    '');
$$;

-- Revoking from anon/authenticated is NOT enough on its own: a function in
-- `public` is granted to PUBLIC by default. Revoke that first, then the roles.
revoke all on function public.sanitize_source_input(text) from public;
revoke all on function public.sanitize_source_input(text) from anon, authenticated;

-- 2. The public booking door. Byte-identical to the live body EXCEPT the
-- v_source line: p_hear_about and p_utm->>'source' are public input and are now
-- bounded before they can become an acquisition source. The raw values still go
-- to v_meta untouched.
create or replace function public.submit_booking(
  p_token text, p_name text, p_email text, p_phone text, p_address text, p_city text,
  p_province text, p_postal text, p_lat double precision, p_lng double precision,
  p_sqft numeric, p_service_type text, p_initial numeric, p_weekly numeric,
  p_biweekly numeric, p_monthly numeric, p_cadence text, p_notes text default null,
  p_hear_about text default null, p_referral_code text default null,
  p_utm jsonb default null, p_photos text[] default null)
returns json language plpgsql security definer set search_path to 'public' as $function$
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

  -- THE ONLY CHANGED LINE in this function.
  v_source := coalesce(
    public.sanitize_source_input(p_hear_about),
    public.sanitize_source_input(p_utm->>'source'),
    'Online Booking');
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

-- 3. The shared identity seam. Byte-identical to the live body EXCEPT the two
-- acquisition_source lines. BK-1's match order (phone last-10 -> email ->
-- address) and the blank-only backfill of phone/email are untouched.
--
-- The INSERT branch is sanitised because submit_booking is not the only public
-- caller: /api/intake is CORS-open and unauthenticated with `source` read from
-- the request body -> submit_website_lead(p_source) -> here.
--
-- FIRST-TOUCH: the source is written when the row is created and is NEVER
-- overwritten by a later touch. The coalesce below fills only a BLANK, so a
-- known source can never be replaced. Contract: "first KNOWN touch wins".
create or replace function public.resolve_intake_customer(
  p_user uuid, p_name text, p_email text, p_phone text, p_address text, p_city text,
  p_province text, p_postal text, p_source text, p_notes text default null)
returns uuid language plpgsql set search_path to 'public' as $function$
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
      public.sanitize_source_input(p_source), nullif(trim(p_notes), '')
    ) returning id into v_customer;
  else
    update public.customers set
      phone = coalesce(phone, v_phone),
      email = coalesce(email, v_email),
      -- THE BACKFILL. Fills a blank; never overwrites a real answer.
      acquisition_source = coalesce(nullif(btrim(acquisition_source), ''),
                                    public.sanitize_source_input(p_source))
    where id = v_customer;
  end if;

  return v_customer;
end;
$function$;