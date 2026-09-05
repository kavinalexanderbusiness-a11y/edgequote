-- ══════════════════════════════════════════════════════════════════════════════
-- Work sessions — the itemisation of a job's recorded time, and the ONE rule
-- that stops it ever disagreeing with the total.
-- Session 47 · 2026-08-13
-- ══════════════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM
-- `jobs.actual_minutes` is a single accumulating integer. It answers "how long
-- did this take" and nothing else — not WHICH DAYS, not HOW MANY PEOPLE. A job
-- worked over three days is one number with no parts, so the only way to record
-- partial work was to finish the visit or to hand-edit the total. There was
-- nowhere to say "worked 3h today, back Thursday" without lying about one of
-- them.
--
-- THE CONTRACT THIS FILE ESTABLISHES, stated once:
--
--   ⭐ A job's `actual_minutes` IS the sum of its work sessions' `minutes`,
--      enforced by the database. Not "kept in sync by the app" — enforced. Any
--      door that writes a disagreeing total has it corrected on the way in.
--
-- That is deliberately a database rule and not an application one, because the
-- total is written by SIX doors today (the calendar's Done, the Day Ops status
-- dropdown, the job form, lib/jobStatus' check-out, /api/crew/complete, and the
-- offline outbox's replay of any of them). Six writers cannot be kept honest by
-- convention; they can be kept honest by one BEFORE trigger they all pass
-- through. See [engineering-principles]: ONE engine per responsibility, DB
-- constraints over app logic.
--
-- ⭐ NO MINUTE IS EVER LOST. A job that already carries a total from before this
-- migration has no sessions, so nothing clamps it — the legacy value stands
-- exactly as written. The first time such a job gains a session, its existing
-- total is CARRIED FORWARD as a session of its own (source='carried') before the
-- new one lands, so the sum can never come out lower than the number the owner
-- already saw. This is the defect class that bit `completeVisit` once already
-- (overwriting instead of accumulating destroyed the first day's hours); it is
-- not being re-introduced through the back door.
--
-- ⭐ ELAPSED TIME vs LABOUR TIME. `minutes` is time ON SITE — the clock. `workers`
-- is how many people were there. `labour_minutes` is GENERATED as their product,
-- so the two can never be confused and neither has to be re-derived by a caller.
-- Three people for two hours = 120 elapsed minutes and 360 labour minutes, and
-- `jobs.actual_minutes` continues to mean ELAPSED, unchanged, because that is
-- what every existing reader (lib/duration's learning, lib/dayFit's clock
-- dimension, estimate-vs-actual) already assumes it means.
--
-- ⛔ NOT a second actual-time source of truth. `time_entries` is the PAYROLL
-- clock — a person's shift, with a snapshot wage, spanning whatever they did
-- that day; it holds 0 rows and answers "what do I owe this employee".
-- `job_work_sessions` answers "what happened on this job on this day". They are
-- different questions and neither is derivable from the other. Nothing here
-- reads, writes or prices `time_entries`, and no wage appears in this file.
--
-- ⛔ NOT payroll, not surveillance. There is no per-person attribution: `workers`
-- is a COUNT, not a roster. A session cannot identify who was on site, and that
-- is a design decision rather than a gap.

begin;

-- ── The table ────────────────────────────────────────────────────────────────
create table if not exists public.job_work_sessions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  job_id      uuid not null,

  -- THE DAY the work happened, in the business's own reckoning. Separate from
  -- created_at because a session logged on Friday morning for Thursday's work is
  -- Thursday's work. Separate from jobs.scheduled_date because that field moves
  -- forward as the job is carried to its next work day — the session must keep
  -- the day it describes even after the job has moved on.
  --
  -- ⚠️ The database does not know the business's timezone, so a trigger-banked
  -- session takes the day from `jobs.scheduled_date` (the business's own
  -- reckoning of which day that visit is) rather than casting a timestamp to a
  -- UTC date — which would file a 6pm start as tomorrow for every tenant west of
  -- Greenwich. Hand-logged sessions carry the date the owner's own browser
  -- computed. Neither path guesses.
  worked_on   date not null,

  -- The clock stretch, when there was one. NULL for time typed in by hand: an
  -- owner who says "worked about 3 hours yesterday" is not claiming 09:00–12:00,
  -- and inventing those endpoints would be fabricating a record.
  started_at  timestamptz,
  ended_at    timestamptz,

  -- ELAPSED on-site minutes. The one figure every session must have — a session
  -- that records no time is not a record of anything. The upper bound is one
  -- week: a sanity rail, not a business rule. A single CLOCK stretch is capped
  -- far lower (1440) by the trigger that creates it, because a clock left
  -- running for more than a day is a mistake rather than a fact; the wider bound
  -- exists so a legacy total accumulated across several days can be carried
  -- forward whole.
  minutes     integer not null check (minutes > 0 and minutes <= 10080),

  -- How many people were on site for it. A COUNT, never a roster.
  workers     integer not null default 1 check (workers >= 1 and workers <= 50),

  -- Person-minutes. GENERATED so "2 hours with 3 people" has exactly one
  -- arithmetic, in the database, and no surface can quietly disagree.
  labour_minutes integer generated always as (minutes * workers) stored,

  -- Optional, short, and about the WORK. Not customer-facing (that is
  -- jobs.completion_summary) and not an instruction to the crew (that is
  -- jobs.notes) — this is "ran out of primer", the reason the day ended.
  note        text check (note is null or char_length(note) <= 280),

  -- How this session came to exist. Read by the UI to word history honestly and
  -- by the guard to prove the carry-forward rule; never used to hide a session.
  source      text not null default 'manual'
                check (source in ('clock', 'manual', 'carried')),

  check (ended_at is null or started_at is null or ended_at >= started_at),

  -- ⭐ COMPOSITE, not a bare job_id. RLS proves who owns the SESSION; a
  -- single-column FK proves only that the job EXISTS. Nothing would have proved
  -- they were the same business — the exact hole that was live in production on
  -- expenses/time_entries/job_line_items until 2026-08-11 (see
  -- RUN-2026-08-11c-job-cost-tenancy.sql). Business A could attach work to
  -- Business B's job, where B's RLS hides it and A's job costing skips it.
  constraint job_work_sessions_job_same_owner
    foreign key (job_id, user_id) references public.jobs(id, user_id) on delete cascade
);

comment on table public.job_work_sessions is
  'One stretch of work on one job on one day. jobs.actual_minutes is the sum of these (enforced by trigger). minutes = elapsed on site; labour_minutes = minutes x workers.';

create index if not exists job_work_sessions_job_idx
  on public.job_work_sessions (user_id, job_id, worked_on desc);
create index if not exists job_work_sessions_day_idx
  on public.job_work_sessions (user_id, worked_on desc);

-- ⭐ The same clock stretch is ONE row. Completing a visit banks the running
-- clock; the undo every completion door offers leaves both the session and the
-- check-in alone; closing it again would otherwise bank the same 09:00 start a
-- second time and double the day. The index makes that impossible rather than
-- unlikely, and the trigger's ON CONFLICT ... DO UPDATE turns the second close
-- into what it actually is — the SAME stretch, now longer.
create unique index if not exists job_work_sessions_one_per_clock
  on public.job_work_sessions (job_id, started_at)
  where started_at is not null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Owner-scoped, like every other business table. ⛔ NO crew policy: a crew
-- session holds no table grants at all, by design — its writes land through the
-- BEFORE trigger below, which runs inside the DEFINER RPC the crew already uses.
-- Adding a policy here would hand a worker direct table access to reach around it.
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

-- ── The sum ──────────────────────────────────────────────────────────────────
-- THE only place a session total is computed. NULL when there are no sessions,
-- never 0: "nothing recorded" and "took no time" are different claims, and a
-- fabricated zero reads downstream as a job that cost no labour at all — a
-- 100%-margin job in every profitability lens. Same rule completionPatch holds.
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

-- Keep the job's total equal to its parts whenever the parts change: a session
-- added, corrected or deleted. Deliberately re-reads the sum rather than adding
-- a delta — a delta can drift, a re-read cannot.
--
-- ⚠️ pg_trigger_depth() IS LOAD-BEARING, not an optimisation. When the jobs
-- BEFORE trigger below banks a clock session, this fires nested inside a command
-- that is already updating that very jobs row. Propagating from here would be
-- Postgres's "tuple to be updated was already modified by an operation triggered
-- by the current command" — the error whose own HINT says to use an AFTER
-- trigger. Nested, there is nothing to do anyway: the BEFORE trigger sets the
-- total itself, from the same sum, before it returns.
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

-- ── Carry forward ────────────────────────────────────────────────────────────
-- ⭐ NO MINUTE IS EVER LOST, and this is where that is enforced. A job carrying a
-- total from before sessions existed gains its first session — by a clock being
-- banked, or by an owner typing "worked 2h yesterday" — and that old total is
-- written as a session of its own FIRST. Without it the sum would replace the
-- total instead of extending it: a job with 180 recorded minutes that gains a
-- 60-minute session would come out at 60, and the earlier work would be gone.
--
-- It lives on the INSERT rather than inside the jobs trigger because the
-- condition is about the first session, not about the clock. Putting it only in
-- the clock path is the bug it was written to fix: a hand-logged first session
-- took the same route and did not carry anything forward.
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

-- ── The clock, banked ────────────────────────────────────────────────────────
-- ⭐⭐ THE trigger that makes this one contract instead of six. It fires on the
-- jobs row itself, so every door — owner, crew RPC, offline replay, a future
-- surface nobody has written yet — passes through it without knowing it exists.
--
-- Two jobs, in order (carry-forward is the insert trigger's, above):
--
--   1. BANK THE CLOCK. When a running check-in is being closed — either the
--      visit is being completed, or started_at is being cleared (stopping for
--      the day) — the stretch from check-in to now becomes a session. The
--      check-in is then cleared, because a clock that has been banked is not
--      still running; the arrival time is not lost, it has moved onto the
--      session row where it now describes a specific day's work.
--
--   2. CLAMP. If the job has any sessions at all, its total is the sum of them.
--      A caller that computed something else (completionPatch's banked+span
--      arithmetic, an owner typing in the actual-minutes box) is corrected here.
--      Callers that got it right — which completionPatch does, since the session
--      it caused is inserted in step 1 before this line runs — see no change.
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

  -- A check-in is being closed: the visit is finishing, or the day is ending.
  v_closing := old.started_at is not null
               and (
                 (new.status = 'completed' and old.status is distinct from 'completed')
                 or new.started_at is null
               );

  if v_closing then
    -- A clock left running overnight is a mistake to correct, not a 30-hour day
    -- to record. Capped here; the owner can edit the session to the truth.
    v_minutes := greatest(1, least(1440,
      (extract(epoch from (now() - old.started_at)) / 60)::integer));

    -- Step 1 — the stretch just worked. ON CONFLICT: this exact check-in has
    -- already been banked, so the second close EXTENDS it rather than adding a
    -- duplicate. That path is real — stop for today → undo → keep working →
    -- stop again — and DO NOTHING silently lost the whole afternoon. `greatest`
    -- means a re-close can only ever lengthen recorded history, never shrink it.
    -- Any pre-session total on this job is carried forward by the insert trigger
    -- this statement passes through.
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

  -- Step 2 — the total is the sum of the parts, whoever wrote it.
  if v_has_sessions then
    v_sum := public.job_session_minutes(new.id);
    if new.actual_minutes is distinct from v_sum then
      new.actual_minutes := v_sum;
    end if;
  end if;

  return new;
end
$$;

-- Postgres runs BEFORE-row triggers in NAME order. The 'aa_' prefix puts this
-- one first, so `crew_job_field_guard` and `handle_updated_at` see the final
-- row. Not load-bearing today — this function writes only started_at and
-- actual_minutes, and the crew guard's protected set contains neither — but the
-- order is pinned rather than left to luck about future columns.
drop trigger if exists aa_bank_job_clock_session on public.jobs;
create trigger aa_bank_job_clock_session
  before update on public.jobs
  for each row execute function public.bank_job_clock_session();

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The owner reaches the table through RLS like every other business table.
-- ⛔ Nothing is granted to `anon`: work history is internal, and the portal RPC
-- does not select it.
grant select, insert, update, delete on public.job_work_sessions to authenticated;

commit;

-- ── Verification (run by hand after applying) ────────────────────────────────
-- select count(*) from public.job_work_sessions;                      -- 0
-- select tgname from pg_trigger where tgrelid='public.jobs'::regclass
--   and not tgisinternal order by tgname;                             -- aa_bank_... first
-- The executable proof, including the cross-tenant refusal and every clamp
-- branch, is `npm run verify:work-sessions`.
