-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716232722
--   name    : workforce_pto_holidays_wage_history_pay_runs
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Workforce: PTO, holidays, wage history, pay runs ─────────────────────────
-- Extends the EXISTING employee record (technicians). No `employees` table.

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
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  technician_id uuid not null,
  old_wage numeric(10,2),
  new_wage numeric(10,2),
  note text,
  constraint wage_history_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id) on delete cascade,
  constraint wage_history_wages_nonneg
    check ((old_wage is null or old_wage >= 0) and (new_wage is null or new_wage >= 0)),
  -- A "change" that changed nothing is noise in an audit trail.
  constraint wage_history_actually_changed
    check (old_wage is distinct from new_wage)
);

create index if not exists wage_history_tech_idx on public.wage_history (technician_id, created_at desc);
create index if not exists wage_history_user_idx on public.wage_history (user_id, created_at desc);

-- The log is written by a TRIGGER, not by app code: a wage change made from any
-- path (roster UI, SQL, a future import) must be recorded. App-side logging can
-- be forgotten; a trigger cannot.
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

-- ── 4. PTO entries — paid time NOT worked ────────────────────────────────────
-- DELIBERATELY NOT time_entries. PTO/holiday hours are not "hours worked", so in
-- every Canadian jurisdiction they do NOT count toward an overtime threshold. If
-- these rows lived in time_entries, lib/payroll would count them as worked and
-- invent overtime: 40h worked + 8h vacation would read as 48h and trigger 4h of
-- OT against a 44h rule. That is a real overpayment on every week containing a
-- day off, so the separation is enforced by schema, not by convention.
create table if not exists public.pto_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  technician_id uuid not null,
  date date not null,
  hours numeric(5,2) not null,
  -- WHY the time was taken. Orthogonal to whether it is paid: unpaid sick leave
  -- and paid sick leave are the same kind of absence, different money.
  kind text not null default 'vacation',
  is_paid boolean not null default true,
  -- Snapshot, exactly like time_entries.hourly_rate: a raise must never rewrite
  -- the value of vacation already taken. NULL = no wage set -> hours, no money.
  hourly_rate numeric(10,2),
  holiday_id uuid references public.holidays(id) on delete set null,
  notes text,
  constraint pto_entries_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id) on delete cascade,
  constraint pto_entries_kind_known
    check (kind in ('vacation','sick','holiday','personal','bereavement')),
  constraint pto_entries_hours_range check (hours > 0 and hours <= 24),
  constraint pto_entries_rate_nonneg check (hourly_rate is null or hourly_rate >= 0),
  -- One row per person per day per kind: prevents the same vacation day being
  -- booked twice by a double-tap.
  constraint pto_entries_one_per_day_kind unique (technician_id, date, kind)
);

create index if not exists pto_entries_user_date_idx on public.pto_entries (user_id, date);
create index if not exists pto_entries_tech_date_idx on public.pto_entries (technician_id, date);

-- ── 5. Pay runs — what you ACTUALLY paid, frozen ─────────────────────────────
-- A finalized pay run is a historical financial record, not a cached view. It
-- SNAPSHOTS both the totals and the overtime rules used to reach them, because:
--   * editing an old time entry must not silently rewrite a cheque already cut;
--   * changing the OT rules must not retroactively restate last month's payroll.
-- This is the same reasoning as time_entries.hourly_rate, one level up.
create table if not exists public.pay_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  period_kind text not null,
  finalized_at timestamptz not null default now(),
  note text,
  -- Rules as they stood at finalize time.
  ot_daily_hours numeric(4,2),
  ot_weekly_hours numeric(5,2),
  ot_multiplier numeric(4,2) not null,
  pay_week_starts_on int not null,
  -- Totals as they stood at finalize time.
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

-- ── 6. Pay run lines — THE pay stub ──────────────────────────────────────────
-- technician_name is snapshot and technician_id uses a COLUMN-SCOPED set null
-- (PG15+). Deleting an employee cascades away their time_entries, which would
-- leave this line as the only surviving record of what they were paid — so it
-- must not cascade. Scoping the SET NULL to technician_id alone keeps user_id
-- intact; a plain composite SET NULL would null user_id too and drop the row out
-- of its owner's RLS scope, orphaning a financial record.
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