-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716001317
--   name    : service_template_cost_and_favorites
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-service cost, material cost, favorites ───────────────────────────────
-- The additive foundation under Price Books. It adds what a price can be JUDGED
-- against; it does not change what a price IS. `default_rate` remains the price,
-- and no resolution layer exists yet.
--
-- WHY NULLABLE, NOT DEFAULT 0
-- A cost of NULL means "not set". A cost of 0 means "this costs me nothing".
-- Defaulting to 0 would silently claim 100% margin on all 27 existing services —
-- a confident, wrong number on a money screen. Every consumer must treat NULL as
-- unknown and show nothing rather than guess. lib/margin.ts enforces that.
--
-- unit_cost      = what delivering ONE unit costs you (labour/subcontract)
-- material_cost  = material cost per unit, kept SEPARATE so a "+ materials"
--                  service can show where its cost actually comes from
-- Total cost per unit = unit_cost + material_cost, with NULL meaning unknown.
--
-- BACKWARDS COMPATIBILITY: additive only. Both costs nullable (existing rows read
-- NULL = unknown = no margin shown, which is the truth). is_favorite defaults
-- false, so every existing service keeps its exact current behaviour and sort.
-- Nothing reads these columns until the code that ships with this migration.
--
-- NOT TOUCHED: lib/pricing.ts. Lawn cadence pricing never consults a cost.

alter table public.service_templates
  add column if not exists unit_cost      numeric,
  add column if not exists material_cost  numeric,
  add column if not exists is_favorite    boolean not null default false;

-- Favorites are a per-owner shortlist surfaced first in the quote builder's
-- picker; index the lookup it will do.
create index if not exists service_templates_favorite_idx
  on public.service_templates (user_id, is_favorite) where is_favorite;

comment on column public.service_templates.unit_cost is
  'What delivering one unit costs (labour/subcontract). NULL = not set; never treat as 0.';
comment on column public.service_templates.material_cost is
  'Material cost per unit. NULL = not set; never treat as 0.';
comment on column public.service_templates.is_favorite is
  'Owner shortlist — surfaced first in the quote builder picker.';