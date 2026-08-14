-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715231804
--   name    : feature_modules_enabled_modules
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

-- Feature-module composition per business (src/lib/modules.ts is the registry).
-- NULL = all modules enabled — the default for every existing and new business,
-- so this column changes nothing until a business explicitly composes its nav.
alter table business_settings add column if not exists enabled_modules jsonb;
comment on column business_settings.enabled_modules is 'Feature-module keys visible in navigation (registry: src/lib/modules.ts). NULL = all modules. Core modules (dashboard) are always shown regardless.';