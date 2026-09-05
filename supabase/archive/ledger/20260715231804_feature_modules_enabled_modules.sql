-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715231804
--   name    : feature_modules_enabled_modules
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Feature-module composition per business (src/lib/modules.ts is the registry).
-- NULL = all modules enabled — the default for every existing and new business,
-- so this column changes nothing until a business explicitly composes its nav.
alter table business_settings add column if not exists enabled_modules jsonb;
comment on column business_settings.enabled_modules is 'Feature-module keys visible in navigation (registry: src/lib/modules.ts). NULL = all modules. Core modules (dashboard) are always shown regardless.';