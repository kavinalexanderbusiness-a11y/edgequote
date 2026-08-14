-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717012955
--   name    : business_type_default_general
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Default served the 2026-07-15 backfill (rows keep stored values); ongoing
-- default must be the neutral fail-safe so an accidental row creation is never
-- lawn-branded. Non-destructive: DEFAULT only, no row touched.
alter table public.business_settings
  alter column business_type set default 'general';