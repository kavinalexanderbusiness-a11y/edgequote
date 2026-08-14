-- ── Analytics workspace layout ───────────────────────────────────────────────
-- APPLIED + VERIFIED in production 2026-07-15 via Supabase MCP (migration
-- `analytics_layout`). Kept here because Supabase's migration history only
-- records post-2026-07-15 work — the repo is still the source of truth.
--
-- Per-user widget order + hidden set for /dashboard/intelligence. Follows the
-- existing per-user jsonb config pattern on business_settings (service_seasons,
-- message_templates, notif_prefs), so it needs no new table and rides the row's
-- existing RLS policies unchanged.
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
