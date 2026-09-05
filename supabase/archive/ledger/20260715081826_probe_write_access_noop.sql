-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715081826
--   name    : probe_write_access_noop
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Write-access probe: re-set an existing comment to the value it already holds.
-- True no-op — identical outcome whether it executes or not.
comment on column public.crm_campaigns.subject is 'Owner-written email subject. Blank → the message template''s built-in subject.';