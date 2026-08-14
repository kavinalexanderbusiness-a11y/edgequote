-- ════════════════════════════════════════════════════════════════════════════
-- OWNER-PROVISIONED EMPLOYEE LOGINS — the state the roster needs to SHOW
-- RUN-2026-08-09-crew-invite.sql
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS COMPLETES
-- Crew Mode (RUN-2026-08-07-crew-mode.sql) could already BIND an existing
-- account to a technician: the owner mints a one-time join code, the employee
-- redeems it. What it could not do was give somebody an account in the first
-- place. This project has signups ENABLED but `mailer_autoconfirm: false`, and
-- the built-in Supabase mailer is rate limited — a probe signup came straight
-- back with "email rate limit exceeded". So a confirmation email is not a path
-- an owner can depend on, and "go and sign yourself up" is not a workflow.
--
-- Provisioning therefore happens server-side through the Supabase Admin API, in
-- ONE owner-authenticated route (src/app/api/crew/invite/route.ts) — the only
-- place in EdgeQuote that creates an auth account. The account is created
-- already confirmed, so no email has to be delivered at all.
--
-- ⭐ NOTHING HERE WIDENS THE CREW DATA BOUNDARY. A crew session still has no
-- table access whatsoever; this file adds one owner-only read and one column.
-- No policy is created, and none is dropped.
--
-- WHAT THE SQL IS FOR
-- Provisioning creates a state the roster could not previously render: LINKED
-- BUT NEVER SIGNED IN. Distinguishing "invited" from "active" needs
-- auth.users.last_sign_in_at, which no owner client can read and which no RLS
-- policy can expose without handing over the rest of that table. Hence a
-- DEFINER read, scoped to the caller's own roster.
--
-- IDEMPOTENT. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. When the owner last handed out a setup link ──────────────────────────
alter table public.technicians
  add column if not exists invite_sent_at timestamptz;

comment on column public.technicians.invite_sent_at is
  'When the owner last generated a setup link for this employee. Cleared on revoke. Paired with auth.users.last_sign_in_at (via crew_access_states) to tell "invited" from "active".';

-- ── 2. The four states, for the whole roster, in one round trip ─────────────
-- Owner-only twice over: rows are filtered to the caller's own technicians, AND
-- the caller must themselves be an owner (have a business_settings row). A crew
-- member calling this gets `{}` — never a teammate's email address.
--
-- It reads auth.users, which is exactly why it is a DEFINER function and not a
-- policy: a policy would have to expose that table, and there is no column-level
-- way to hold back everything else on it.
create or replace function public.crew_access_states()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke execute on function public.crew_access_states() from public, anon;
grant execute on function public.crew_access_states() to authenticated;

-- ── 3. Revoking forgets the invite too ──────────────────────────────────────
-- Unchanged except for `invite_sent_at`: without it the roster keeps reporting
-- "Invite pending" for somebody whose access the owner has just taken away.
create or replace function public.crew_revoke_access(p_technician_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke execute on function public.crew_revoke_access(uuid) from public, anon;
grant execute on function public.crew_revoke_access(uuid) to authenticated;
