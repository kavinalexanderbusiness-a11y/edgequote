-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811074609
--   name    : property_internal_notes
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.properties
  add column if not exists internal_notes text;

comment on column public.properties.internal_notes is
  'Private to the owner and crew: never returned by get_portal_data and never rendered in the customer portal. Home for access and site facts about the PLACE (gate side, dog, shut-off/controller location, parking). Customer-facing property notes stay in `notes`; private notes about the PERSON stay in customers.notes.';