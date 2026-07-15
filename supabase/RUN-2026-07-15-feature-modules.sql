-- ── Feature-module composition per business ─────────────────────────────────
-- APPLIED to production 2026-07-15 via MCP (verified before and after).
-- Committed for the repo's migration record — the repo is the source of truth.
--
-- src/lib/modules.ts is THE registry of feature modules; navigation renders
-- from it. This column lets a business compose which modules it sees:
--   NULL              → all modules (the default; every existing business)
--   ["schedule", ...] → only those keys (+ core modules, which never hide)
-- Enforcement is at the navigation level — data and deep links stay intact.

alter table business_settings add column if not exists enabled_modules jsonb;

comment on column business_settings.enabled_modules is
  'Feature-module keys visible in navigation (registry: src/lib/modules.ts). NULL = all modules. Core modules (dashboard) are always shown regardless.';
