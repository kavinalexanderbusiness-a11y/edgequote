-- ── Employee time & wages: the paid-time ledger ──────────────────────────────
-- APPLIED to production 2026-07-16 via Supabase MCP (apply_migration) and read
-- back live (columns, constraints, RLS, trigger, indexes, and both guards proven
-- by execution — see VERIFICATION below). Committed because the repo remains the
-- source of truth for migration history.
--
-- WHY
-- `technicians` (RUN-2026-07-15-dispatch-crews) already IS the employee record:
-- name / phone / email / role / status / is_active / crew_id. It was missing the
-- two things payroll needs — what a person COSTS, and the hours they actually
-- worked. This adds exactly that, ON the existing table. There is deliberately NO
-- `employees` table: a second "who works here" table would be a rival source of
-- truth (see engineering principles — ONE engine per responsibility).
--
-- WHAT `status` IS NOT
-- technicians.status is a DISPATCH state (available/en_route/on_job/break/off) —
-- "where is this person right now". It is NOT paid time and must never be used to
-- compute hours: a tech can be 'off' with an open shift (forgot to clock out), or
-- 'on_job' unclocked. Paid time lives here, in time_entries, and only here.
--
-- WHY hourly_rate IS SNAPSHOT ON THE ENTRY, not read from technicians
-- Payroll history must not move when a wage changes. If cost were computed as
-- minutes x technicians.hourly_wage, giving someone a raise would silently rewrite
-- the cost of every shift they ever worked — including exported/paid periods.
-- The rate is stamped at clock-in and stays put. technicians.hourly_wage is only
-- the DEFAULT for the next clock-in.
--
-- TWO GUARDS THAT ARE DB-LEVEL ON PURPOSE (app logic can't be trusted with these)
--  1. one open shift per technician  -> partial unique index. Makes double
--     clock-in impossible rather than merely discouraged.
--  2. cross-tenant reference         -> composite FK (technician_id, user_id) ->
--     technicians(id, user_id). RLS alone does NOT stop owner A writing a time
--     entry against owner B's technician (A's own user_id passes the policy).
--
-- minutes_worked is GENERATED so no caller can disagree about what a shift is
-- worth. NULL while the shift is open — an open shift has no duration yet, and
-- 0 would be a lie.
--
-- SAFETY: additive only. New table + three nullable columns. Nothing dropped,
-- nothing backfilled (technicians had 0 rows), no existing column altered. Fully
-- idempotent (if not exists / guarded exception blocks).
--
-- VERIFICATION — executed against prod inside a transaction that was rolled back,
-- so no test rows persisted (both tables re-read at 0 afterwards):
--   * minutes_worked: 09:00->17:00 with a 30m break = 450         ✅
--   * open-shift guard: 2nd open clock-in    -> unique_violation  ✅
--   * clock_out before clock_in              -> check_violation   ✅
--   * negative break_minutes                 -> check_violation   ✅
--   * entry vs unmatched technician (comp FK)-> fk_violation      ✅
--   * negative hourly_wage                   -> check_violation   ✅
--   * TRUE cross-tenant (owner B's entry vs owner A's technician): NOT PROVEN —
--     this project has only ONE auth user, so it could not be exercised. The
--     composite FK is the mechanism and it demonstrably rejects an unmatched
--     (technician_id, user_id) pair; re-run that case once a second owner exists.
-- Structure read back live: 3 columns added, RLS on + 4 policies, 5 indexes,
-- updated_at trigger, minutes_worked = GENERATED ALWAYS, in supabase_realtime.

-- ── 1. Wage + employment dates on the EXISTING employee record ───────────────
alter table public.technicians
  add column if not exists hourly_wage numeric(10,2),
  add column if not exists hired_on    date,
  add column if not exists ended_on    date;

comment on column public.technicians.hourly_wage is
  'Default pay rate for the NEXT clock-in. Historical cost lives on time_entries.hourly_rate (snapshot) — changing this never rewrites past shifts.';

do $$ begin
  alter table public.technicians add constraint technicians_hourly_wage_nonneg
    check (hourly_wage is null or hourly_wage >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.technicians add constraint technicians_employment_dates_ordered
    check (ended_on is null or hired_on is null or ended_on >= hired_on);
exception when duplicate_object then null; end $$;

-- Composite key so time_entries can FK (technician_id, user_id). id is already
-- unique, so this is trivially satisfied and costs only an index.
do $$ begin
  alter table public.technicians add constraint technicians_id_user_key
    unique (id, user_id);
exception when duplicate_object then null; end $$;

-- ── 2. time_entries — THE paid-time ledger ───────────────────────────────────
create table if not exists public.time_entries (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  technician_id  uuid not null,
  -- Optional: time can be job-linked (billable/costable) or general (yard, travel,
  -- shop). set null on job delete — deleting a job must never delete someone's pay.
  job_id         uuid references public.jobs(id) on delete set null,
  clock_in       timestamptz not null default now(),
  clock_out      timestamptz,                    -- NULL = currently on the clock
  break_minutes  int not null default 0,
  -- Pay rate SNAPSHOT taken at clock-in (see header).
  hourly_rate    numeric(10,2),
  notes          text,

  constraint time_entries_clock_order
    check (clock_out is null or clock_out > clock_in),
  constraint time_entries_break_nonneg
    check (break_minutes >= 0),
  constraint time_entries_rate_nonneg
    check (hourly_rate is null or hourly_rate >= 0),
  -- Cross-tenant guard (see header).
  constraint time_entries_technician_same_owner
    foreign key (technician_id, user_id)
    references public.technicians (id, user_id) on delete cascade,

  -- Paid minutes, derived by the DB. NULL while open.
  minutes_worked int generated always as (
    case when clock_out is null then null
         else greatest(0, (extract(epoch from (clock_out - clock_in)) / 60)::int - break_minutes)
    end
  ) stored
);

comment on table public.time_entries is
  'THE paid-time ledger. One row per shift. minutes_worked is DB-derived; hourly_rate is snapshotted at clock-in so wage changes never rewrite history. Open shift = clock_out IS NULL (at most one per technician, enforced by index).';

-- At most ONE open shift per technician. This is what makes double clock-in
-- impossible instead of merely unlikely.
create unique index if not exists time_entries_one_open_per_tech
  on public.time_entries (technician_id) where clock_out is null;

create index if not exists time_entries_user_idx on public.time_entries(user_id, clock_in desc);
create index if not exists time_entries_tech_idx on public.time_entries(technician_id, clock_in desc);
create index if not exists time_entries_job_idx  on public.time_entries(job_id);

alter table public.time_entries enable row level security;

drop policy if exists "time_entries: select own" on public.time_entries;
drop policy if exists "time_entries: insert own" on public.time_entries;
drop policy if exists "time_entries: update own" on public.time_entries;
drop policy if exists "time_entries: delete own" on public.time_entries;
create policy "time_entries: select own" on public.time_entries for select using (auth.uid() = user_id);
create policy "time_entries: insert own" on public.time_entries for insert with check (auth.uid() = user_id);
create policy "time_entries: update own" on public.time_entries for update using (auth.uid() = user_id);
create policy "time_entries: delete own" on public.time_entries for delete using (auth.uid() = user_id);

drop trigger if exists time_entries_updated_at on public.time_entries;
create trigger time_entries_updated_at before update on public.time_entries
  for each row execute procedure public.handle_updated_at();

-- ── 3. Realtime (same guarded pattern as the dispatch migration) ─────────────
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['time_entries'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
