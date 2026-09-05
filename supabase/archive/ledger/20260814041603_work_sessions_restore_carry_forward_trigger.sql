-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814041603
--   name    : work_sessions_restore_carry_forward_trigger
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restores the carry-forward trigger after the guard's mutation test.
drop trigger if exists aa_carry_forward_job_actual_minutes on public.job_work_sessions;
create trigger aa_carry_forward_job_actual_minutes
  before insert on public.job_work_sessions
  for each row execute function public.carry_forward_job_actual_minutes();