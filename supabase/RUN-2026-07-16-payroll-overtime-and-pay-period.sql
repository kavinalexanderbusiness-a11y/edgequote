-- ── Payroll: overtime rules + pay period ─────────────────────────────────────
-- APPLIED to production 2026-07-16 via Supabase MCP (apply_migration) and read
-- back live. Committed because the repo remains the source of truth for
-- migration history.
--
-- WHY
-- technicians (RUN-2026-07-15-dispatch-crews) is the employee record and
-- time_entries (RUN-2026-07-16-employee-time-and-wages) is the paid-time ledger.
-- Between them they answer "who worked, how long, at what rate" — but not "which
-- of those hours are overtime, and which payday do they land on". That is what
-- this adds. No new table: these are business settings, and business_settings is
-- where business settings live (ONE source of truth). There is deliberately NO
-- `employees` and NO `payroll_config` table.
--
-- WHY OVERTIME DEFAULTS TO OFF (both thresholds NULL)
-- Overtime law is jurisdictional: Alberta 8/day & 44/week, B.C. 8/day & 40/week,
-- Ontario 44/week with no daily rule. Shipping "8 and 44" as a default would
-- silently inflate an Ontario owner's payroll and understate a B.C. owner's — a
-- wrong number that looks authoritative. NULL means "this rule does not apply";
-- the owner opts in (Settings → Payroll ships one-tap province presets).
--
-- WORK WEEK ≠ PAY PERIOD, and they are stored separately on purpose.
--   pay_week_starts_on -> the OT boundary (legally load-bearing).
--   pay_period         -> how often cheques are cut.
-- A biweekly period contains two OT weeks, each judged on its own. Defaults to 1
-- (Monday) to match the week the existing timesheet already shows.
--
-- CONSUMED BY lib/payroll ONLY — the one payroll engine. No other module reads
-- these columns; no screen computes overtime for itself.
--
-- SAFETY: additive only. Six columns on an existing table, five CHECK
-- constraints, no column altered, nothing backfilled, nothing dropped. Adding a
-- NOT NULL column WITH a default does not rewrite the table on PG11+. Idempotent
-- (add column if not exists + guarded exception blocks).
--
-- VERIFICATION — every guard proven by EXECUTION against prod inside a
-- transaction that was rolled back (defaults re-read intact afterwards: 1.50 /
-- biweekly / 1):
--   * ot_multiplier = 0.5        -> check_violation  ✅ (OT can't be a pay cut)
--   * pay_period = 'fortnightly' -> check_violation  ✅
--   * pay_week_starts_on = 7     -> check_violation  ✅
--   * ot_daily_hours = 25        -> check_violation  ✅
--   * ot_weekly_hours = 0        -> check_violation  ✅
--
-- CALCULATIONS verified end-to-end against real rows in prod (seeded, computed,
-- rolled back — technicians and time_entries both re-read at 0 afterwards). The
-- Alberta 8/44 case, five 10h days @ $30:
--   * Postgres' GENERATED minutes_worked total = 3000 (50 h)   ✅
--   * daily OT  = 600 min (10 h)                               ✅
--   * weekly OT = 360 min (6 h)                                ✅
--   * OT charged = greater-of = 600, NOT the sum (960)         ✅
--   * regular = 2400 min (40 h); pay = 40*30 + 10*30*1.5 = 1650.00 ✅
--   * SQL result identical to lib/payroll's TypeScript output  ✅
-- lib/payroll additionally verified by execution over 48 cases (greater-of rule,
-- weekly-only/daily-only/off, blended multi-rate weeks, snapshot-rate immunity to
-- a raise, open shifts unpaid, unrated hours, and every pay-period boundary +
-- round-trip). That run caught a real defect: a blended rate scaled by 60 twice.
--
-- NOTE: production currently has 0 technicians and 0 time_entries, so no live
-- payroll data existed to verify against — the figures above come from realistic
-- rows seeded into prod and rolled back, with Postgres' own generated column as
-- the arbiter.

alter table public.business_settings
  add column if not exists ot_daily_hours     numeric(4,2),
  add column if not exists ot_weekly_hours    numeric(5,2),
  add column if not exists ot_multiplier      numeric(4,2) not null default 1.5,
  add column if not exists pay_period         text not null default 'biweekly',
  add column if not exists pay_period_anchor  date,
  add column if not exists pay_week_starts_on int  not null default 1;

comment on column public.business_settings.ot_daily_hours is
  'Hours in a DAY after which OT applies. NULL = no daily rule (e.g. Ontario). Alberta 8, BC 8.';
comment on column public.business_settings.ot_weekly_hours is
  'Hours in a WORK WEEK after which OT applies. NULL = no weekly rule. Alberta 44, BC/ON 40/44.';
comment on column public.business_settings.ot_multiplier is
  'Pay multiplier for overtime minutes (1.5 = time-and-a-half). Never below 1.';
comment on column public.business_settings.pay_period is
  'weekly | biweekly | semimonthly | monthly. Drives the payroll summary window.';
comment on column public.business_settings.pay_period_anchor is
  'Any start date of a known period. Biweekly needs it to know WHICH two weeks; NULL falls back to the first pay_week_starts_on of 1970 (deterministic).';
comment on column public.business_settings.pay_week_starts_on is
  '0=Sun..6=Sat. The OT WORK WEEK boundary — legally load-bearing, so it is explicit rather than assumed. Defaults to 1 (Mon) to match the existing timesheet week.';

-- A multiplier below 1 would make overtime a pay CUT.
do $$ begin
  alter table public.business_settings add constraint business_settings_ot_multiplier_min
    check (ot_multiplier >= 1);
exception when duplicate_object then null; end $$;

-- 0 is not "off" — NULL is. A 0 threshold would make every minute overtime.
do $$ begin
  alter table public.business_settings add constraint business_settings_ot_daily_range
    check (ot_daily_hours is null or (ot_daily_hours > 0 and ot_daily_hours <= 24));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_ot_weekly_range
    check (ot_weekly_hours is null or (ot_weekly_hours > 0 and ot_weekly_hours <= 168));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_pay_period_kind
    check (pay_period in ('weekly','biweekly','semimonthly','monthly'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_pay_week_start_range
    check (pay_week_starts_on between 0 and 6);
exception when duplicate_object then null; end $$;
