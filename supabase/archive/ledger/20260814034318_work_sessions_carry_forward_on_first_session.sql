-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034318
--   name    : work_sessions_carry_forward_on_first_session
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Carry-forward must fire for the FIRST session however it arrives — a clock
-- being banked, or an owner typing "worked 2h yesterday" on a job that already
-- carries a total from before sessions existed. Doing it only in the jobs
-- trigger meant a hand-logged first session replaced a legacy total instead of
-- adding to it. It now lives where the condition actually is: the first insert.
create or replace function public.carry_forward_job_actual_minutes()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prior integer;
  v_crew  integer;
  v_day   date;
begin
  -- 'carried' is the row this function itself writes — without this it recurses.
  if new.source = 'carried' then
    return new;
  end if;
  if exists (select 1 from public.job_work_sessions where job_id = new.job_id) then
    return new;
  end if;
  select j.actual_minutes, greatest(1, coalesce(j.crew_size, 1)), j.scheduled_date
    into v_prior, v_crew, v_day
    from public.jobs j where j.id = new.job_id;
  if coalesce(v_prior, 0) > 0 then
    insert into public.job_work_sessions
      (user_id, job_id, worked_on, minutes, workers, source)
    values (new.user_id, new.job_id, v_day, least(10080, v_prior), v_crew, 'carried');
  end if;
  return new;
end
$$;

drop trigger if exists aa_carry_forward_job_actual_minutes on public.job_work_sessions;
create trigger aa_carry_forward_job_actual_minutes
  before insert on public.job_work_sessions
  for each row execute function public.carry_forward_job_actual_minutes();

-- With carry-forward owned by the insert path, the jobs trigger drops its own
-- copy of it and keeps only the two things that are genuinely about the jobs
-- row: banking a running clock, and refusing to hold a total that disagrees
-- with its parts.
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
    on conflict do nothing;
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