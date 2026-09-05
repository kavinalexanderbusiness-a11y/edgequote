-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715082324
--   name    : probe_write_access_noop
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Zero-effect probe, re-run after the MCP server reconnected. This table comment
-- is already NULL (verified), so this sets null to null: it changes nothing whether
-- it succeeds or fails. Sole purpose is to learn whether writes are permitted now.
comment on table public.road_distance_cache is null;