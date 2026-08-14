-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260813201019
--   name    : service_template_recurrence_eligibility
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Session 46: service-level recurrence eligibility (Day Suggestions V1).
-- The smallest useful model: three explicit answers, NULL = unconfigured.
-- No keyword inference anywhere — this column is the ONLY thing that may say
-- "this service is one-time-only" / "this service is naturally repeatable".
alter table public.service_templates
  add column if not exists recurrence text
  check (recurrence is null or recurrence in ('one_time','recurring_ok','usually_recurring'));

comment on column public.service_templates.recurrence is
  'Recurrence eligibility: one_time = never suggest recurring; recurring_ok = recurrence suggestions allowed; usually_recurring = this service is normally a recurring plan. NULL = owner has not said (suggestions then require behavioural cadence evidence).';