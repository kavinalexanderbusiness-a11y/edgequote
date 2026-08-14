-- ── Workforce: PTO, holidays, wage history, pay runs ─────────────────────────
-- APPLIED to production 2026-07-16 via Supabase MCP (apply_migration), read back
-- live, and every guard proven by execution (see VERIFICATION). Committed because
-- the repo remains the source of truth for migration history.
--
-- WHY
-- `technicians` IS the employee record (RUN-2026-07-15-dispatch-crews) and
-- `time_entries` IS the paid-time ledger (RUN-2026-07-16-employee-time-and-wages).
-- This adds the four things payroll still couldn't answer — time off, holidays,
-- what someone's rate USED to be, and what you actually paid last period. All of
-- it hangs off technicians. There is still deliberately NO `employees` table.
--
-- ═══ THE ONE DECISION THAT MATTERS MOST: PTO IS NOT time_entries ═══
-- PTO/holiday hours are NOT "hours worked", so in every Canadian jurisdiction
-- they do not count toward an overtime threshold. Had these rows been a `kind`
-- column on time_entries, lib/payroll would have counted a vacation day as worked
-- and invented overtime on every week containing one:
--     40h worked + 8h vacation -> read as 48h -> 4h OT against a 44h rule
-- That is a real overpayment, every week, for every employee who takes a day off.
-- A separate table makes it STRUCTURALLY impossible: lib/payroll only ever
-- receives TimeEntry[], so it cannot see a PTO row even by mistake. The
-- separation is the safeguard — not a convention someone must remember.
-- Proven by execution below, including the counterfactual.
--
-- WHY pay_runs SNAPSHOT INSTEAD OF RECOMPUTING
-- Once you've paid someone, that's history. A recomputed-on-read pay run would let
-- an edited shift — or a corrected OT rule, or a raise — silently restate a cheque
-- that already cleared. So finalizing writes down the totals AND the OT rules that
-- produced them. Same principle as time_entries.hourly_rate, one level up. Drift
-- is then detected and surfaced (lib/payRun.detectDrift) rather than hidden.
--
-- WHY pay_run_lines SURVIVE EMPLOYEE DELETION
-- Deleting a technician CASCADES their time_entries away, which would leave the
-- pay stub as the only surviving record of what they were paid — so it must not
-- cascade too. PG15+ column-scoped `ON DELETE SET NULL (technician_id)` nulls the
-- link but keeps user_id; a plain composite SET NULL would null user_id as well
-- and drop the row out of its owner's RLS scope, orphaning a financial record.
-- Postgres here is 17.6 (checked before relying on it). technician_name is
-- snapshot so a stub still prints a name after the roster row is gone.
--
-- WHY wage_history IS A TRIGGER, NOT APP CODE
-- A wage change made from any path — the roster UI, a SQL fix, a future import —
-- must be recorded. App-side logging can be forgotten; a trigger cannot.
--
-- WHY clock_timestamp() AND seq ON wage_history
-- now() returns TRANSACTION START time, so every row written in one transaction
-- ties exactly and 'order by created_at' is non-deterministic — an audit trail
-- whose order is ambiguous can't answer "what was the wage progression". Found by
-- execution: a 3-changes-in-one-transaction test returned the STARTING wage as
-- "latest". clock_timestamp() is the real wall clock (what an audit event means);
-- `seq` is a monotonic tiebreaker so the order is provably total. ORDER BY seq.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- Statutory holiday pay. The formula differs by province (Alberta's average daily
-- wage over 4 weeks vs BC's over 30 days vs Ontario's own) and eligibility has its
-- own tests. Getting it wrong means underpaying someone — a legal problem, not a
-- rounding error. So a holiday is paid hours the OWNER sets, at the employee's own
-- rate; lib/pto.averageDailyWage() is offered as a labelled INPUT, never applied
-- automatically. Same "don't guess a jurisdictional rule" stance as OT defaults.
--
-- SAFETY: additive only. Five new tables + one nullable column on technicians.
-- Nothing dropped, nothing backfilled, no existing column altered. Idempotent
-- (create table if not exists / add column if not exists / guarded blocks).
--
-- VERIFICATION — executed against prod inside transactions that were ROLLED BACK
-- (all seven tables re-read at 0 rows afterwards):
--   * PTO/OT separation, the whole point:
--       worked=2400min(40h) + 8h vacation -> OT = 0            ✅ no phantom OT
--       gross = 1200 worked + 240 PTO = 1440.00                ✅ matches TS engine
--       counterfactual: same 8h AS WORKED TIME -> OT = 240min  ✅ the bug we prevent
--   * pay stub survives employee deletion:
--       after DELETE technician -> time_entries = 0 (cascaded)  ✅
--                               -> pay_run_lines = 1 (SURVIVED) ✅
--       stub name intact, technician_id nulled, user_id intact  ✅
--   * wage_history trigger: starting wage logged on INSERT (1 row)        ✅
--       raise logged on UPDATE (2 rows), no-op update NOT logged (still 2) ✅
--       3 changes in ONE transaction -> distinct timestamps, correct order ✅
--       (oldest NULL->25 starting wage; newest 32->38 latest raise)
--   * guards, each proven to REJECT:
--       pto kind 'sabbatical'      -> check_violation   ✅
--       pto hours = 25             -> check_violation   ✅
--       pto same person/day/kind   -> unique_violation  ✅ (no double-booking)
--       holiday duplicate date     -> unique_violation  ✅
--       pay run duplicate period   -> unique_violation  ✅
--   * RLS on + 4 policies on each of the 5 new tables, read back live ✅
--   * lib/pto + lib/payRun + laborCost additionally verified by execution over 55
--     cases (phantom-OT prevention, real OT preserved alongside PTO, vacation-only
--     paycheques, unpaid leave, snapshot immunity to a raise, balances excluding
--     holidays from drawdown, holiday eligibility by hired_on/ended_on, crew
--     revenue conservation, drift detection using the run's own frozen rules).
--
-- NOTE: production has 0 technicians and 0 time_entries, so there was no live
-- payroll data to verify against — the figures above come from realistic rows
-- seeded into prod and rolled back, with Postgres as the arbiter.

-- ── 1. PTO allowance on the existing employee record ─────────────────────────
alter table public.technicians
  add column if not exists pto_annual_hours numeric(6,2);

comment on column public.technicians.pto_annual_hours is
  'Annual PTO allowance in hours. NULL = no allowance configured -> usage is tracked but no balance is claimed (never guess someone''s entitlement).';

do $$ begin
  alter table public.technicians add constraint technicians_pto_allowance_nonneg
    check (pto_annual_hours is null or pto_annual_hours >= 0);
exception when duplicate_object then null; end $$;

-- ── 2. Wage history — an audit trail, never a pricing source ─────────────────
create table if not exists public.wage_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  seq bigint generated by default as identity,
  user_id uuid not null references auth.users(id) on delete cascade,
  technician_id uuid not null,
  old_wage numeric(10,2),
  new_wage numeric(10,2),
  note text,
  constraint wage_history_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id) on delete cascade,
  constraint wage_history_wages_nonneg
    check ((old_wage is null or old_wage >= 0) and (new_wage is null or new_wage >= 0)),
  constraint wage_history_actually_changed
    check (old_wage is distinct from new_wage)
);

comment on column public.wage_history.created_at is
  'clock_timestamp() (real wall clock), NOT now() — now() is transaction start and ties every row written in one transaction.';
comment on column public.wage_history.seq is
  'Monotonic tiebreaker. ORDER BY seq for a provably total audit order; created_at can tie at microsecond resolution.';

create index if not exists wage_history_tech_idx on public.wage_history (technician_id, created_at desc);
create index if not exists wage_history_user_idx on public.wage_history (user_id, created_at desc);
create index if not exists wage_history_tech_seq_idx on public.wage_history (technician_id, seq desc);

create or replace function public.log_wage_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.hourly_wage is not null then
      insert into public.wage_history (user_id, technician_id, old_wage, new_wage, note)
      values (new.user_id, new.id, null, new.hourly_wage, 'Starting wage');
    end if;
    return new;
  end if;
  if new.hourly_wage is distinct from old.hourly_wage then
    insert into public.wage_history (user_id, technician_id, old_wage, new_wage)
    values (new.user_id, new.id, old.hourly_wage, new.hourly_wage);
  end if;
  return new;
end $$;

drop trigger if exists technicians_log_wage_change on public.technicians;
create trigger technicians_log_wage_change
  after insert or update of hourly_wage on public.technicians
  for each row execute function public.log_wage_change();

-- ── 3. Holidays — ONE holiday calendar for the business ──────────────────────
create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  name text not null,
  is_paid boolean not null default true,
  default_hours numeric(5,2) not null default 8,
  constraint holidays_one_per_day unique (user_id, date),
  constraint holidays_hours_range check (default_hours >= 0 and default_hours <= 24)
);

create index if not exists holidays_user_date_idx on public.holidays (user_id, date);

-- ── 4. PTO entries — paid time NOT worked (see the header) ───────────────────
create table if not exists public.pto_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  technician_id uuid not null,
  date date not null,
  hours numeric(5,2) not null,
  kind text not null default 'vacation',
  is_paid boolean not null default true,
  hourly_rate numeric(10,2),
  holiday_id uuid references public.holidays(id) on delete set null,
  notes text,
  constraint pto_entries_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id) on delete cascade,
  constraint pto_entries_kind_known
    check (kind in ('vacation','sick','holiday','personal','bereavement')),
  constraint pto_entries_hours_range check (hours > 0 and hours <= 24),
  constraint pto_entries_rate_nonneg check (hourly_rate is null or hourly_rate >= 0),
  constraint pto_entries_one_per_day_kind unique (technician_id, date, kind)
);

create index if not exists pto_entries_user_date_idx on public.pto_entries (user_id, date);
create index if not exists pto_entries_tech_date_idx on public.pto_entries (technician_id, date);

-- ── 5. Pay runs — what you ACTUALLY paid, frozen ─────────────────────────────
create table if not exists public.pay_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  period_kind text not null,
  finalized_at timestamptz not null default now(),
  note text,
  ot_daily_hours numeric(4,2),
  ot_weekly_hours numeric(5,2),
  ot_multiplier numeric(4,2) not null,
  pay_week_starts_on int not null,
  regular_minutes int not null default 0,
  ot_minutes int not null default 0,
  worked_pay numeric(12,2) not null default 0,
  pto_hours numeric(8,2) not null default 0,
  pto_pay numeric(12,2) not null default 0,
  gross_pay numeric(12,2) not null default 0,
  employee_count int not null default 0,
  constraint pay_runs_one_per_period unique (user_id, period_start, period_end),
  constraint pay_runs_period_order check (period_end >= period_start),
  constraint pay_runs_kind_known check (period_kind in ('weekly','biweekly','semimonthly','monthly')),
  constraint pay_runs_multiplier_min check (ot_multiplier >= 1),
  constraint pay_runs_week_start_range check (pay_week_starts_on between 0 and 6),
  constraint pay_runs_minutes_nonneg check (regular_minutes >= 0 and ot_minutes >= 0)
);

create index if not exists pay_runs_user_period_idx on public.pay_runs (user_id, period_start desc);

-- ── 6. Pay run lines — THE pay stub (survives employee deletion) ─────────────
create table if not exists public.pay_run_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pay_run_id uuid not null references public.pay_runs(id) on delete cascade,
  technician_id uuid,
  technician_name text not null,
  technician_role text,
  regular_minutes int not null default 0,
  ot_minutes int not null default 0,
  blended_rate numeric(10,2) not null default 0,
  regular_pay numeric(12,2) not null default 0,
  ot_pay numeric(12,2) not null default 0,
  pto_hours numeric(8,2) not null default 0,
  pto_pay numeric(12,2) not null default 0,
  gross_pay numeric(12,2) not null default 0,
  shifts int not null default 0,
  unrated_minutes int not null default 0,
  constraint pay_run_lines_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id)
    on delete set null (technician_id),
  constraint pay_run_lines_one_per_tech unique (pay_run_id, technician_id),
  constraint pay_run_lines_minutes_nonneg check (regular_minutes >= 0 and ot_minutes >= 0),
  constraint pay_run_lines_name_present check (length(trim(technician_name)) > 0)
);

create index if not exists pay_run_lines_run_idx on public.pay_run_lines (pay_run_id);
create index if not exists pay_run_lines_tech_idx on public.pay_run_lines (technician_id);

-- ── 7. updated_at triggers (reuse the existing shared function) ──────────────
drop trigger if exists holidays_updated_at on public.holidays;
create trigger holidays_updated_at before update on public.holidays
  for each row execute function public.set_updated_at();

drop trigger if exists pto_entries_updated_at on public.pto_entries;
create trigger pto_entries_updated_at before update on public.pto_entries
  for each row execute function public.set_updated_at();

-- ── 8. RLS — same shape as every other tenant table ──────────────────────────
alter table public.wage_history  enable row level security;
alter table public.holidays      enable row level security;
alter table public.pto_entries   enable row level security;
alter table public.pay_runs      enable row level security;
alter table public.pay_run_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wage_history','holidays','pto_entries','pay_runs','pay_run_lines'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format('create policy %I_update on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    execute format('create policy %I_delete on public.%I for delete using (auth.uid() = user_id)', t, t);
  end loop;
end $$;
