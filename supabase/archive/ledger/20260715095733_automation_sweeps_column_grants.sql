-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715095733
--   name    : automation_sweeps_column_grants
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- The heartbeat answers "did the cron run", which is platform health and safe for any
-- signed-in owner to see. It must NOT answer "how many businesses use EdgeQuote" —
-- `owners`, `detected` and `written` are GLOBAL aggregates across every tenant, and a
-- row-level policy cannot hide a column. Column grants can.
--
-- So: no table-wide select. Owners get liveness (job / ran_on / ran_at / ok / error);
-- the counts stay service-role-only, readable by the crons that write them.

revoke select on public.automation_sweeps from anon, authenticated;

grant select (job, ran_on, ran_at, ok, error) on public.automation_sweeps to authenticated;