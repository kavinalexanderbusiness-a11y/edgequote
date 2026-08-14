-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260810063320
--   name    : public_edge_hardening_20260810
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

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
    if v_byte < 248 then
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

do $$
declare
  v_src text;
  v_codes text[] := '{}';
  v_one  text;
  v_byte int;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_booking_measurement';
  if v_src not like '%q.user_id = v_user%' then
    raise exception 'record_booking_measurement does not re-scope p_quote_id';
  end if;
  if v_src not like '%interval ''1 hour''%' then
    raise exception 'record_booking_measurement lost its rate limit';
  end if;

  if not has_function_privilege('anon',
    'public.record_booking_measurement(text,uuid,double precision,double precision,text,numeric,numeric,numeric,text)',
    'execute') then
    raise exception 'anon lost EXECUTE — the public booking form would stop recording measurements';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'crew_issue_invite';
  if v_src like '%random()%' then
    raise exception 'crew_issue_invite still uses the predictable PRNG';
  end if;
  if v_src not like '%gen_random_bytes%' then
    raise exception 'crew_issue_invite is not using a CSPRNG';
  end if;
  perform extensions.gen_random_bytes(1);

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