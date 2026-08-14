-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715233211
--   name    : business_type_column
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- RUN-2026-07-15-business-type.sql
-- The vertical foundation, layer 1: WHICH TRADE a business is. One column.
--
-- business_type selects seed data and copy (trade packs, src/lib/trades) and
-- NOTHING else: no engine — pricing, scheduling, dispatch, automation, routing,
-- invoicing, reporting — may ever branch on it. Composition happens through what
-- it SEEDS (service_templates, service_seasons, enabled_modules), which the
-- owner then owns outright.
--
-- NOT NULL DEFAULT 'lawn_landscaping' IS the backfill: every existing business
-- becomes lawn_landscaping without an UPDATE, and behaves identically because
-- nothing reads the column yet.
--
-- Format check only, deliberately NOT a membership enum: the pack registry in
-- code is the source of truth, and an unknown value falls back to the neutral
-- pack. A new trade must never need a migration.
alter table public.business_settings
  add column if not exists business_type text not null default 'lawn_landscaping';

alter table public.business_settings
  drop constraint if exists business_settings_business_type_format;
alter table public.business_settings
  add constraint business_settings_business_type_format
  check (business_type ~ '^[a-z][a-z0-9_]*$');

comment on column public.business_settings.business_type is
  'Trade/vertical key (registry: src/lib/trades). Selects seed data and default copy ONLY — engines never branch on it. Unknown key = neutral pack.';