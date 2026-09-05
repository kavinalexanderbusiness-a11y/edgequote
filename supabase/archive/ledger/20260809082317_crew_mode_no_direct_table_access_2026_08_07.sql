-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809082317
--   name    : crew_mode_no_direct_table_access_2026_08_07
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Crew Mode, tightened: a crew session gets NO direct table access.
--
-- WHY. The first cut gave crew a row-level SELECT policy on `jobs`, which is how
-- PostgREST returns a representation after a PATCH. But RLS is ROW-level: being
-- granted the row grants every COLUMN on it, so a worker could ask for
-- `jobs?select=price` and read the revenue on their own stops. crew_day() was
-- carefully column-limited and then undercut by the policy sitting next to it.
-- Column privileges can't fix it either — a GRANT is role-wide, so restricting
-- `authenticated` would restrict the owner too.
--
-- So the crew surface becomes what the customer portal already is in this
-- codebase: RPCs only. Two doors — crew_day/crew_upcoming to read, and
-- crew_set_visit_status to write — each naming its own columns.
--
-- The canonical row is still the one being written, and the values still come
-- from lib/jobStatus.completionPatch: this function takes the STAMP as typed
-- parameters (never a jsonb blob a client could stuff extra columns into) and
-- applies it. One definition of "done", two audiences, no second job model.

drop policy if exists "jobs: crew reads assigned" on public.jobs;
drop policy if exists "jobs: crew updates assigned" on public.jobs;

-- crew_job_field_guard STAYS. Nothing can reach it through a policy any more,
-- which is the point of keeping it: if a future change ever re-adds a crew
-- UPDATE policy, the columns are still pinned and the mistake is contained.

create or replace function public.crew_set_visit_status(
  p_job_id           uuid,
  p_status           text,
  p_base_updated_at  timestamptz,
  p_started_at       timestamptz default null,
  p_completed_at     timestamptz default null,
  p_actual_minutes   integer     default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_updated  timestamptz;
begin
  if v_employer is null or v_crew is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;
  -- The field lifecycle, and only it. 'cancelled' is a business decision: a
  -- worker who cannot finish leaves the visit open for the office.
  if p_status not in ('scheduled', 'in_progress', 'completed') then
    raise exception 'crew may not set a visit to %', p_status using errcode = '42501';
  end if;

  -- Assignment is re-checked HERE because this function is DEFINER and so runs
  -- past the RLS that would otherwise do it. Optimistic concurrency rides in the
  -- same predicate: if the office moved the visit while the phone held an old
  -- copy, nothing matches and the caller is told, rather than overwriting them.
  update public.jobs j
     set status         = p_status,
         started_at     = p_started_at,
         completed_at   = p_completed_at,
         actual_minutes = p_actual_minutes
   where j.id = p_job_id
     and j.user_id = v_employer
     and j.crew_id = v_crew
     and j.updated_at = p_base_updated_at
  returning j.updated_at into v_updated;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end
$fn$;

revoke all on function public.crew_set_visit_status(uuid, text, timestamptz, timestamptz, timestamptz, integer) from public;
grant execute on function public.crew_set_visit_status(uuid, text, timestamptz, timestamptz, timestamptz, integer) to authenticated;