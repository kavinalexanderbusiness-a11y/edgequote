-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715092117
--   name    : analytics_layout
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Analytics workspace layout — per-user widget order + hidden set for
-- /dashboard/intelligence. Follows the existing per-user jsonb config pattern on
-- business_settings (service_seasons, message_templates, notif_prefs), so it
-- needs no new table and rides the row's existing RLS.
--
-- Shape: { "order": ["executive","financial",...], "hidden": ["yearly"] }
-- Unknown ids are ignored and missing ids fall back to the default order, so a
-- saved layout can never hide a widget added in a later release.
--
-- NOT reusing the existing `dashboard_cards` column: that belongs to the old home
-- dashboard shell removed in 019c24c and still holds ids for deleted components
-- ("suggestions","stats","recent","acquisition"). It is dead but left in place —
-- dropping it is a separate, explicit decision.
alter table public.business_settings
  add column if not exists analytics_layout jsonb;

comment on column public.business_settings.analytics_layout is
  'Analytics workspace layout: { "order": [widgetId], "hidden": [widgetId] }. Unknown ids ignored; missing ids append in default order.';