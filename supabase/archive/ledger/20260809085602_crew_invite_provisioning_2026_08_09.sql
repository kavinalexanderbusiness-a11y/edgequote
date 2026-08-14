-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809085602
--   name    : crew_invite_provisioning_2026_08_09
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Owner-provisioned employee logins: the state the roster needs to SHOW.
--
-- Crew Mode could already bind an existing account to a technician (a one-time
-- join code). What it could not do was give somebody an account in the first
-- place — this project's Supabase mailer is rate-limited, so the self-signup
-- confirmation email is not a path an owner can depend on. Provisioning now
-- happens server-side through the Admin API, which means the roster has a new
-- state to render: LINKED BUT NEVER SIGNED IN.
--
-- `invite_sent_at` records when the owner last handed out a setup link. Whether
-- they have actually ARRIVED is auth.users.last_sign_in_at, which no owner
-- client can read — hence crew_access_states() below, a DEFINER read scoped to
-- the caller's own roster.

alter table public.technicians
  add column if not exists invite_sent_at timestamptz;

comment on column public.technicians.invite_sent_at is
  'When the owner last generated a setup link for this employee. Cleared on revoke. Paired with auth.users.last_sign_in_at (via crew_access_states) to tell "invited" from "active".';

-- The four states, for the whole roster, in one round trip. Owner-only: a crew
-- member calling this gets an empty object, not somebody else''s email.
create or replace function public.crew_access_states()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    jsonb_object_agg(
      t.id::text,
      jsonb_build_object(
        'linked', t.auth_user_id is not null,
        'email', u.email,
        'last_sign_in_at', u.last_sign_in_at,
        'invite_sent_at', t.invite_sent_at,
        'has_code', t.invite_code is not null and coalesce(t.invite_expires_at, now()) > now()
      )
    ),
    '{}'::jsonb
  )
  from public.technicians t
  left join auth.users u on u.id = t.auth_user_id
  where t.user_id = auth.uid()
    and exists (select 1 from public.business_settings b where b.user_id = auth.uid())
$fn$;

revoke execute on function public.crew_access_states() from public, anon;
grant execute on function public.crew_access_states() to authenticated;

-- Revoking must also forget the invite, or the roster keeps claiming a link was
-- sent to somebody who no longer has access.
create or replace function public.crew_revoke_access(p_technician_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.technicians t where t.id = p_technician_id and t.user_id = auth.uid()
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;
  update public.technicians
     set auth_user_id = null, invite_code = null, invite_expires_at = null, invite_sent_at = null
   where id = p_technician_id;
  return jsonb_build_object('revoked', true);
end
$fn$;

revoke execute on function public.crew_revoke_access(uuid) from public, anon;
grant execute on function public.crew_revoke_access(uuid) to authenticated;