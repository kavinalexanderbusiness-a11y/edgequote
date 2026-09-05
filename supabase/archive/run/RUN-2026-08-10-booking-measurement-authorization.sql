-- ── record_booking_measurement: a token is tenant authority, not booking authority ──
-- 2026-08-10. Follow-up to RUN-2026-08-10-public-edge-hardening.sql, which re-scoped
-- this RPC's p_quote_id and gave it an hourly ceiling. That closed ID SUBSTITUTION.
-- It did not close the hole underneath it, because the re-scope was conditional:
--
--     if p_quote_id is not null and not exists (... user_id = v_user) then return false;
--
-- With p_quote_id NULL there was nothing to re-scope, so the only thing the caller
-- had to prove was possession of the booking token — which is PUBLIC by construction
-- (it is the /book/<token> URL a business prints on its own website). No booking, no
-- customer, no quote: just a token, and the row landed.
--
-- ⚠️ WHY THAT MATTERED — this is not a tidiness fix. lib/autoMeasure's
-- getNeighborhoodRatio selects measurements by user_id + neighborhood ONLY (no
-- context, no source filter), averages accepted_sqft / building_sqft, and once
-- CALIBRATION_MIN_SAMPLES (= 5) rows exist it returns that average as the
-- business's CALIBRATED lawn:footprint ratio for the neighborhood. That ratio sizes
-- auto-measurement, and the measured area is what the quote is priced from.
--
-- The neighborhood is just the first three characters of a postal code
-- (lib/profitability neighborhoodKey), and it arrived as a caller-supplied string.
-- So an anonymous caller could pick any bucket in the city and, in FIVE calls, hand
-- that business a fabricated calibration for it.
--
-- REPRODUCED as `anon` against the live token, rolled back: five calls with
-- p_quote_id NULL, p_neighborhood 'T2N', building 1000 / accepted 100 drove the
-- bucket's calibrated ratio to 0.100 against a default of 2.3 — a 23x
-- under-measurement applied to every later quote in that postal prefix.
--
-- ── THE CONTRACT NOW ─────────────────────────────────────────────────────────
-- The token still says WHICH BUSINESS. Everything that decides where the row lands
-- is re-derived inside the trusted boundary from the booking the caller names:
--   · a quote id is REQUIRED — no anchor, no write (fail closed);
--   · that quote must belong to the token's business (unchanged, now unconditional);
--   · customer_id and property_id are read OFF that quote, never accepted;
--   · the neighborhood is computed from the quote's PERSISTED property, and
--     p_neighborhood is ignored entirely.
-- The signature is unchanged, so no caller has to be redeployed in step with this.
--
-- What a determined attacker can still do — stated plainly — is make a real booking
-- and record one measurement against it. That is the function working: the row lands
-- in the bucket of the address they actually booked, attached to a customer and
-- quote the owner can see in their CRM, and capped by the ceiling below. What is
-- gone is silent, unattributable poisoning of a neighborhood they never touched.

begin;

create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision,
  p_neighborhood text, p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text)
returns boolean
language plpgsql
security definer
-- pg_temp is deliberately ABSENT rather than pinned last. Verified empirically:
-- with a temp table named `measurements` in the caller's session this function still
-- wrote to public.measurements, because an explicit search_path that omits pg_temp
-- excludes it from relation lookup altogether.
set search_path to 'public'
as $function$
declare
  v_user     uuid;
  v_customer uuid;
  v_property uuid;
  v_hood     text;
  v_found    boolean := false;
begin
  -- 1. WHICH BUSINESS. The token proves this and only this.
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;

  -- 2. WHICH BOOKING. Unconditional now — a missing anchor is a refusal, not a
  --    reason to skip the check. This is the line the exploit walked past.
  if p_quote_id is null then return false; end if;

  select true, q.customer_id, q.property_id
    into v_found, v_customer, v_property
    from public.quotes q
   where q.id = p_quote_id and q.user_id = v_user;
  if not coalesce(v_found, false) then return false; end if;

  -- 3. Ceiling, counted over the rows THIS function creates. Scoping it to
  --    context='booking' matters both ways: an owner measuring properties from the
  --    dashboard can no longer exhaust the public funnel's allowance, and a flood
  --    here is measured against the thing being flooded.
  if (select count(*) from public.measurements
       where user_id = v_user and context = 'booking'
         and created_at > now() - interval '1 hour') >= 30 then
    return false;
  end if;

  -- 4. WHERE. Derived from the property the booking actually resolved to. Mirrors
  --    lib/profitability neighborhoodKey (neighborhood, else 3-char postal, else
  --    city, else 'Unknown') so the bucket a legitimate booking lands in is the same
  --    one it landed in before — but chosen by the data, not by the request.
  select case
           when nullif(btrim(pr.neighborhood), '') is not null then btrim(pr.neighborhood)
           when length(btrim(coalesce(pr.postal_code, ''))) >= 3 then upper(left(btrim(pr.postal_code), 3))
           when nullif(btrim(coalesce(pr.city, '')), '')  is not null then btrim(pr.city)
           else 'Unknown'
         end
    into v_hood
    from public.properties pr
   where pr.id = v_property and pr.user_id = v_user;
  -- No property, or a property with nothing to key on, buckets as 'Unknown'. It must
  -- NOT fall back to p_neighborhood — that is the input being taken away.
  v_hood := coalesce(v_hood, 'Unknown');

  insert into public.measurements (user_id, quote_id, customer_id, property_id, lat, lng, neighborhood,
      context, source, confidence, building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, v_customer, v_property, p_lat, p_lng, v_hood,
      'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      -- Arithmetic untouched — this migration is authorization only.
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end $function$;

-- ── Grants: named roles only ─────────────────────────────────────────────────
-- The ACL was {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}.
-- That leading `=X` is a grant to PUBLIC, so EXECUTE was held by every role in the
-- cluster, present and future, independently of the three named ones. The named
-- grants are the intended ones — `anon` genuinely needs this, it is the public
-- booking form — so revoking PUBLIC changes nothing for a legitimate caller and
-- removes the inherited path.
-- ⚠️ Revoke names PUBLIC explicitly: a per-role revoke leaves `=X/postgres` standing
-- and has_function_privilege() keeps answering true. That mistake was caught by a
-- verify block once already; hence the assertions below.
revoke execute on function public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)
  from public, anon, authenticated;
grant execute on function public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)
  to anon, authenticated, service_role;

-- ── Prove it ─────────────────────────────────────────────────────────────────
do $$
declare
  v_src text;
  v_sig constant text :=
    'public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)';
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_booking_measurement';

  if v_src not like '%if p_quote_id is null then return false%' then
    raise exception 'the booking anchor is not required — the unauthenticated path is open again';
  end if;
  if v_src like '%p_neighborhood%' and v_src not like '%v_hood%' then
    raise exception 'the neighborhood is still taken from the caller';
  end if;
  if v_src not like '%q.user_id = v_user%' then
    raise exception 'the quote is no longer re-scoped to the token''s business';
  end if;
  if v_src not like '%context = ''booking''%' then
    raise exception 'the ceiling is no longer scoped to booking-context rows';
  end if;

  -- The booking form must still work; nobody else should inherit EXECUTE.
  if not has_function_privilege('anon', v_sig, 'execute') then
    raise exception 'anon lost EXECUTE — the public booking form would stop recording measurements';
  end if;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception 'service_role lost EXECUTE';
  end if;
  if (select proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_booking_measurement') like '%{=X/%' then
    raise exception 'EXECUTE is still granted to PUBLIC';
  end if;

  raise notice 'record_booking_measurement authorization verified';
end $$;

commit;
