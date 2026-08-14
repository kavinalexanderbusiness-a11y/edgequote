-- ── Public edge hardening — 2026-08-10 ───────────────────────────────────────
-- Follow-up to the tenant audit (RUN-2026-08-10-tenant-rpc-grants.sql), which
-- left a ranked list of things that were real but not yet fixed. This file
-- closes two of them. Both live on the UNAUTHENTICATED edge, where the only
-- credential is a booking token that is public by construction — it is the
-- /book/<token> URL a business publishes on its own website.
--
--   1. record_booking_measurement — rate limit + re-scope its quote id.
--   2. crew_issue_invite — join codes from a CSPRNG instead of random().
--
-- Idempotent (create or replace), and it proves its own work at the bottom
-- rather than trusting that the statements above did what they say. That block
-- is not ceremony: the previous migration's verify caught a real mistake of mine
-- (a per-role revoke that left a PUBLIC grant standing) and rolled the whole
-- thing back.
--
-- ⚠️ record_booking_measurement was already applied live on 2026-08-10; this
-- file is the repo's copy of that definition, per the house rule that a live
-- change must have a committed RUN-*.sql explaining it. Re-running is a no-op.

begin;

-- ── 1. record_booking_measurement ────────────────────────────────────────────
-- REPRODUCED as `anon` against the live booking token: two calls inserted two
-- fabricated rows carrying 99999 sq ft (56 -> 58 rows). Measurements feed
-- pricing intelligence, so this was an open channel for poisoning an owner's
-- pricing data — and it was the ONE token RPC in the codebase that inserted a
-- caller-supplied id verbatim. Its sibling booking_set_consent already resolves
-- p_quote_id through `where id = ... and user_id = v_user`; this now matches.
--
-- Verified after the fix: a foreign quote id and a nonexistent quote id are both
-- refused with 0 rows landed (56 -> 56), and a legitimate booking still records
-- (56 -> 57). Normal usage is ~1 measurement per booking, so a ceiling of 30/hr
-- only ever bites on abuse. `anon` keeps EXECUTE — the public booking form is
-- the intended caller.
create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision,
  p_neighborhood text, p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_user uuid;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;

  -- RATE LIMIT. Same idiom and window as book_service's own limiter.
  if (select count(*) from public.measurements
       where user_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    return false;
  end if;

  -- RE-SCOPE THE CALLER'S ID. The token proves which BUSINESS is speaking; it
  -- does not make every id the caller then names belong to that business.
  if p_quote_id is not null
     and not exists (select 1 from public.quotes q where q.id = p_quote_id and q.user_id = v_user)
  then
    return false;
  end if;

  insert into public.measurements (user_id, quote_id, lat, lng, neighborhood, context, source, confidence,
      building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, p_lat, p_lng, nullif(p_neighborhood, ''), 'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end $function$;

-- ── 2. crew_issue_invite: a join code is a credential ────────────────────────
-- The audit flagged "join-code entropy". The LENGTH is fine — 8 chars of a
-- 31-char alphabet is ~2^39.6, the code is single-use, expires in <=72h, and
-- redeeming needs a signed-in non-owner account, so brute force is not the
-- threat (it would take ~10^11 attempts inside the window).
--
-- The RNG is the threat. `random()` is a deterministic PRNG seeded PER SESSION,
-- and Supabase serves requests from a connection POOL, so backend sessions are
-- shared between tenants. An owner can call this on their own roster as often as
-- they like and read every code back. Observing enough outputs from a pooled
-- session recovers that session's PRNG state — and then codes issued through the
-- same session for ANOTHER business are predictable rather than guessable. A
-- predicted code needs one redeem attempt, which is why throttling redeems does
-- not address this and fixing the source of randomness does.
--
-- gen_random_bytes (pgcrypto, installed in `extensions`) is a CSPRNG. Rejection
-- sampling — discarding bytes >= 248 = 8*31 — keeps the alphabet uniform rather
-- than letting `% 31` bias the first 8 characters.
--
-- FORWARD-SAFE: only newly issued codes change. Codes already in a technician's
-- hands keep working, and they expire on their own within 72 hours anyway. The
-- format, length and alphabet are untouched, so a code is still short enough to
-- read aloud over the phone.
create or replace function public.crew_issue_invite(p_technician_id uuid, p_hours integer default 72)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code text := '';
  v_exp  timestamptz;
  v_byte int;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.technicians t
    where t.id = p_technician_id and t.user_id = auth.uid() and t.archived_at is null
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;

  while length(v_code) < 8 loop
    v_byte := get_byte(extensions.gen_random_bytes(1), 0);
    if v_byte < 248 then                      -- 248 = 8 * 31; reject the rest
      v_code := v_code || substr(v_alphabet, 1 + (v_byte % 31), 1);
    end if;
  end loop;

  v_exp := now() + make_interval(hours => greatest(1, least(720, p_hours)));

  update public.technicians
     set invite_code = v_code, invite_expires_at = v_exp
   where id = p_technician_id;

  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end
$function$;

-- ── Prove it ─────────────────────────────────────────────────────────────────
do $$
declare
  v_src text;
  v_codes text[] := '{}';
  v_one  text;
  v_byte int;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  -- 1. The measurement RPC re-scopes its id and caps its rate.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_booking_measurement';
  if v_src not like '%q.user_id = v_user%' then
    raise exception 'record_booking_measurement does not re-scope p_quote_id';
  end if;
  if v_src not like '%interval ''1 hour''%' then
    raise exception 'record_booking_measurement lost its rate limit';
  end if;

  -- 2. The booking form must still be able to call it.
  if not has_function_privilege('anon',
    'public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)',
    'execute') then
    raise exception 'anon lost EXECUTE — the public booking form would stop recording measurements';
  end if;

  -- 3. No random() left in the invite path, and the CSPRNG is really reachable.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'crew_issue_invite';
  if v_src like '%random()%' then
    raise exception 'crew_issue_invite still uses the predictable PRNG';
  end if;
  if v_src not like '%gen_random_bytes%' then
    raise exception 'crew_issue_invite is not using a CSPRNG';
  end if;
  perform extensions.gen_random_bytes(1);   -- raises here, not at invite time, if pgcrypto moved

  -- 4. Codes are the promised shape and are not repeating.
  -- ⚠️ Generated with the SAME plpgsql loop the function uses, deliberately.
  -- The obvious SQL spelling of this test is wrong: an UNCORRELATED scalar
  -- subquery becomes an InitPlan and is evaluated ONCE no matter how many rows
  -- the outer series has, so all 20 "codes" come back identical and the check
  -- fails against a perfectly good CSPRNG. (It did, on the first run of this
  -- migration.) A plpgsql loop re-evaluates per iteration, which is also exactly
  -- what the function above does — so this tests the real code path.
  for i in 1..20 loop
    v_one := '';
    while length(v_one) < 8 loop
      v_byte := get_byte(extensions.gen_random_bytes(1), 0);
      if v_byte < 248 then v_one := v_one || substr(v_alphabet, 1 + (v_byte % 31), 1); end if;
    end loop;
    v_codes := v_codes || v_one;
  end loop;
  if (select count(distinct u) from unnest(v_codes) u) <> 20 then
    raise exception 'sampled join codes collided — the CSPRNG is not behaving';
  end if;
  if not (select bool_and(u ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$') from unnest(v_codes) u) then
    raise exception 'join codes are not 8 chars of the readable alphabet';
  end if;

  raise notice 'public-edge hardening verified';
end $$;

commit;
