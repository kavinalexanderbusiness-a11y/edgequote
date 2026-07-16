-- ── Module update-system state ───────────────────────────────────────────────
-- APPLIED to production 2026-07-15 via MCP (verified before and after).
-- Committed for the repo's migration record — the repo is the source of truth.
--
-- Per-module install state for src/lib/modules.ts (the feature-module
-- registry / marketplace foundation):
--   { [moduleKey]: { "v": installedVersion, "at": ISO timestamp } }
-- Written by the install/uninstall workflow and the "Updated — Got it"
-- acknowledgement in Settings → Modules. NULL or a missing key means the
-- business adopted the module before the update system existed and is
-- treated as current — existing businesses are never nagged.

alter table business_settings add column if not exists module_meta jsonb;

comment on column business_settings.module_meta is
  'Per-module install state { key: { v: installedVersion, at: ISO } } — drives the Modules update badges (registry: src/lib/modules.ts). NULL = treat everything as current.';
