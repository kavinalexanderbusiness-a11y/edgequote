-- ── Service templates: cost to deliver + favourites ──────────────────────────
-- STATUS: APPLIED + VERIFIED in production 2026-07-15 (via Supabase MCP).
-- Recorded here because the repo — not the migration history — is the source of
-- truth for this project's schema.
--
-- The additive foundation under Price Books. Three columns, no rewrite: nothing
-- reads these to PRICE anything. lib/pricing.ts (lawn cadence) and
-- serviceLineTotals (qty × unit_price) are untouched and never see a cost — cost
-- only ever JUDGES a price after the fact, via lib/margin.ts.
--
-- WHY THE COSTS ARE NULLABLE WITH NO DEFAULT — the load-bearing decision here.
-- `default 0` would have been the natural thing to type, and it would have been a
-- lie: it makes "I have never entered a cost" indistinguishable from "this costs
-- nothing", and every one of the 27 existing templates would have reported 100%
-- margin on a money screen. NULL means unknown; margin/markup return null and the
-- UI renders nothing at all. Do not add a default to these columns.
--
-- BACKWARDS COMPATIBILITY: all three are additive. Existing rows get NULL/NULL/
-- false, every existing read (`select *`, the quote builder, the picker) is
-- unaffected, and no existing price moves by a cent.

alter table public.service_templates
  add column if not exists unit_cost      numeric,   -- labour / subcontract, per unit. NULL = not tracked.
  add column if not exists material_cost  numeric,   -- materials consumed, per unit. NULL = not tracked.
  add column if not exists is_favorite    boolean not null default false;

-- Partial: only favourites are ever looked up by this, and they are a small
-- minority of a business's catalogue.
create index if not exists service_templates_favorite_idx
  on public.service_templates (user_id, is_favorite)
  where is_favorite;

-- ── Verification (run after applying) ────────────────────────────────────────
-- Expect: is_favorite:false:NO | material_cost:null:YES | unit_cost:null:YES
--   select column_name || ':' || coalesce(column_default,'null') || ':' || is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='service_templates'
--     and column_name in ('unit_cost','material_cost','is_favorite')
--   order by column_name;
--
-- Expect cost_unset_rows = total rows (every pre-existing template is "unknown",
-- NOT zero — this is the assertion that proves no margin was invented):
--   select count(*) total,
--          count(*) filter (where unit_cost is null and material_cost is null) cost_unset_rows,
--          count(*) filter (where is_favorite) favourites
--   from public.service_templates;
