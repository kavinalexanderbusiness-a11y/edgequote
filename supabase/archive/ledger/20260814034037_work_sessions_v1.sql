-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034037
--   name    : work_sessions_v1
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.job_work_sessions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  job_id      uuid not null,
  worked_on   date not null,
  started_at  timestamptz,
  ended_at    timestamptz,
  minutes     integer not null check (minutes > 0 and minutes <= 10080),
  workers     integer not null default 1 check (workers >= 1 and workers <= 50),
  labour_minutes integer generated always as (minutes * workers) stored,
  note        text check (note is null or char_length(note) <= 280),
  source      text not null default 'manual'
                check (source in ('clock', 'manual', 'carried')),
  check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint job_work_sessions_job_same_owner
    foreign key (job_id, user_id) references public.jobs(id, user_id) on delete cascade
);

comment on table public.job_work_sessions is
  'One stretch of work on one job on one day. jobs.actual_minutes is the sum of these (enforced by trigger). minutes = elapsed on site; labour_minutes = minutes x workers.';

create index if not exists job_work_sessions_job_idx
  on public.job_work_sessions (user_id, job_id, worked_on desc);
create index if not exists job_work_sessions_day_idx
  on public.job_work_sessions (user_id, worked_on desc);
create unique index if not exists job_work_sessions_one_per_clock
  on public.job_work_sessions (job_id, started_at)
  where started_at is not null;

alter table public.job_work_sessions enable row level security;

drop policy if exists "own work sessions select" on public.job_work_sessions;
create policy "own work sessions select" on public.job_work_sessions
  for select using (auth.uid() = user_id);
drop policy if exists "own work sessions insert" on public.job_work_sessions;
create policy "own work sessions insert" on public.job_work_sessions
  for insert with check (auth.uid() = user_id);
drop policy if exists "own work sessions update" on public.job_work_sessions;
create policy "own work sessions update" on public.job_work_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own work sessions delete" on public.job_work_sessions;
create policy "own work sessions delete" on public.job_work_sessions
  for delete using (auth.uid() = user_id);

drop trigger if exists job_work_sessions_updated_at on public.job_work_sessions;
create trigger job_work_sessions_updated_at
  before update on public.job_work_sessions
  for each row execute function public.handle_updated_at();

create or replace function public.job_session_minutes(p_job_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select sum(minutes)::integer from public.job_work_sessions where job_id = p_job_id;
$$;

comment on function public.job_session_minutes(uuid) is
  'Sum of a job''s work-session minutes. NULL when it has none (unknown, not zero).';

create or replace function public.sync_job_actual_minutes()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_job uuid := coalesce(new.job_id, old.job_id);
  v_sum integer;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  v_sum := public.job_session_minutes(v_job);
  update public.jobs
     set actual_minutes = v_sum
   where id = v_job
     and actual_minutes is distinct from v_sum;
  return null;
end
$$;

drop trigger if exists trg_sync_job_actual_minutes on public.job_work_sessions;
create trigger trg_sync_job_actual_minutes
  after insert or update or delete on public.job_work_sessions
  for each row execute function public.sync_job_actual_minutes();

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

    if not v_has_sessions and coalesce(old.actual_minutes, 0) > 0 then
      insert into public.job_work_sessions
        (user_id, job_id, worked_on, minutes, workers, source)
      values
        (old.user_id, old.id, old.scheduled_date,
         least(10080, old.actual_minutes), greatest(1, coalesce(old.crew_size, 1)), 'carried');
      v_has_sessions := true;
    end if;

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

drop trigger if exists aa_bank_job_clock_session on public.jobs;
create trigger aa_bank_job_clock_session
  before update on public.jobs
  for each row execute function public.bank_job_clock_session();

grant select, insert, update, delete on public.job_work_sessions to authenticated;