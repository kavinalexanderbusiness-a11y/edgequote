-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814035646
--   name    : work_sessions_reclose_extends_the_stretch
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- A check-in that is closed TWICE is one stretch that got longer, not two
-- stretches. It happens on a real path: stop for today → undo (the job isn't
-- finished for the day after all) → keep working → stop again. With DO NOTHING
-- the second close banked nothing at all and the afternoon vanished.
--
-- DO UPDATE extends the existing session to the later finish, which is exactly
-- what jobs.actual_minutes did before sessions existed (completionPatch always
-- recomputed the whole span from the check-in). Same number, now itemised.
create or replace function public.bank_job_clock_session()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_has_sessions boolean;
  v_closing      boolean;
  v_minutes      integer;
  v_sum          integer;
begin
  select exists (select 1 from public.job_work_sessions where job_id = new.id)
    into v_has_sessions;

  v_closing := old.started_at is not null
               and (
                 (new.status = 'completed' and old.status is distinct from 'completed')
                 or new.started_at is null
               );

  if v_closing then
    v_minutes := greatest(1, least(1440,
      (extract(epoch from (now() - old.started_at)) / 60)::integer));
    insert into public.job_work_sessions
      (user_id, job_id, worked_on, started_at, ended_at, minutes, workers, source)
    values
      (old.user_id, old.id, old.scheduled_date,
       old.started_at, now(), v_minutes,
       greatest(1, coalesce(new.crew_size, old.crew_size, 1)), 'clock')
    on conflict (job_id, started_at) where started_at is not null
    do update set
      ended_at = excluded.ended_at,
      minutes  = greatest(public.job_work_sessions.minutes, excluded.minutes);
    v_has_sessions := true;
    new.started_at := null;
  end if;

  if v_has_sessions then
    v_sum := public.job_session_minutes(new.id);
    if new.actual_minutes is distinct from v_sum then
      new.actual_minutes := v_sum;
    end if;
  end if;

  return new;
end
$$;