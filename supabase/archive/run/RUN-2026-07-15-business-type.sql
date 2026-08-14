-- ── The vertical foundation, layer 1: WHICH TRADE a business is ──────────────
-- APPLIED to production 2026-07-15 via MCP (verified before and after).
-- Committed for the repo's migration record — the repo is the source of truth.
--
-- business_type selects seed data and copy (trade packs, src/lib/trades) and
-- NOTHING else: no engine — pricing, scheduling, dispatch, automation, routing,
-- invoicing, reporting, AI — may ever branch on it. Composition happens through
-- what it SEEDS (service_templates, service_seasons, enabled_modules), which the
-- owner then owns outright. One platform; trades plug in as data.
--
-- NOT NULL DEFAULT 'lawn_landscaping' IS the backfill: every existing business
-- becomes lawn_landscaping without an UPDATE, and behaves identically because
-- nothing branches on the column.
--
-- Format check only, deliberately NOT a membership enum: the pack registry in
-- code is the source of truth, and an unknown value falls back to the neutral
-- pack (fails safe). A new trade must never need a migration.
alter table public.business_settings
  add column if not exists business_type text not null default 'lawn_landscaping';

alter table public.business_settings
  drop constraint if exists business_settings_business_type_format;
alter table public.business_settings
  add constraint business_settings_business_type_format
  check (business_type ~ '^[a-z][a-z0-9_]*$');

comment on column public.business_settings.business_type is
  'Trade/vertical key (registry: src/lib/trades). Selects seed data and default copy ONLY — engines never branch on it. Unknown key = neutral pack.';
