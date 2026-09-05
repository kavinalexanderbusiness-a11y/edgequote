-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716000641
--   name    : module_meta_update_system
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Per-module install state for the module update system (src/lib/modules.ts):
--   { [moduleKey]: { "v": installedVersion, "at": ISO timestamp } }
-- NULL/missing key = adopted before the update system existed = treated as
-- current (never nags existing businesses).
alter table business_settings add column if not exists module_meta jsonb;
comment on column business_settings.module_meta is 'Per-module install state { key: { v: installedVersion, at: ISO } } — drives the Modules update badges (registry: src/lib/modules.ts). NULL = treat everything as current.';