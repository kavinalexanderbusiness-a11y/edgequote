-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809082831
--   name    : crew_mode_tighten_function_grants_2026_08_07
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Shrink the crew RPC surface to exactly what the app calls.
--
-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon/authenticated/service_role, and that default is applied at CREATE time —
-- so the `revoke ... from public` in the migration did not remove it. None of
-- these are exploitable by anon (each one starts from auth.uid(), which is NULL,
-- and returns null or raises), but a reader should not have to re-derive that
-- for eleven functions. Grant only what is actually called.

-- Internal identity helpers: called only from inside the other DEFINER functions,
-- which run as their owner and so need no grant of their own.
revoke execute on function public.crew_employer() from anon, authenticated;
revoke execute on function public.crew_technician_id() from anon, authenticated;
revoke execute on function public.crew_crew_id() from anon, authenticated;

-- A trigger function is never an endpoint.
revoke execute on function public.crew_job_field_guard() from public, anon, authenticated;

-- The app calls these only with a session in hand.
revoke execute on function public.current_app_role() from anon;
revoke execute on function public.crew_day(date) from anon;
revoke execute on function public.crew_upcoming(date, integer) from anon;
revoke execute on function public.crew_set_visit_status(uuid, text, timestamptz, timestamptz, timestamptz, integer) from anon;
revoke execute on function public.crew_issue_invite(uuid, integer) from anon;
revoke execute on function public.crew_redeem_invite(text) from anon;
revoke execute on function public.crew_revoke_access(uuid) from anon;