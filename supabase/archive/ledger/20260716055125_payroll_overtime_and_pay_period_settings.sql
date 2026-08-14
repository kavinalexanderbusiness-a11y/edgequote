-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716055125
--   name    : payroll_overtime_and_pay_period_settings
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Overtime rules + pay period, on the EXISTING business_settings row.
-- No new "employees" or "payroll_config" table: these are business settings and
-- business_settings is where business settings live (ONE source of truth).
--
-- OT DEFAULTS TO OFF (both thresholds NULL) ON PURPOSE. Overtime law is
-- jurisdictional (AB 8/44, BC 8/40, ON 44 weekly-only...). Guessing a threshold
-- would silently inflate every owner's payroll and mis-state what they owe.
-- Null threshold = that rule does not apply; the owner opts in explicitly.
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

do $$ begin
  alter table public.business_settings add constraint business_settings_ot_daily_range
    check (ot_daily_hours is null or (ot_daily_hours > 0 and ot_daily_hours <= 24));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_ot_weekly_range
    check (ot_weekly_hours is null or (ot_weekly_hours > 0 and ot_weekly_hours <= 168));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_ot_multiplier_min
    check (ot_multiplier >= 1);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_pay_period_kind
    check (pay_period in ('weekly','biweekly','semimonthly','monthly'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_settings add constraint business_settings_pay_week_start_range
    check (pay_week_starts_on between 0 and 6);
exception when duplicate_object then null; end $$;