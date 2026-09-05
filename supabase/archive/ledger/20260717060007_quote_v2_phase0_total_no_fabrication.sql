-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717060007
--   name    : quote_v2_phase0_total_no_fabrication
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Backfill from hours*crew_size*rate (NOT from total — total includes travel_fee).
update public.quotes
   set initial_price = round((hours * crew_size * rate)::numeric, 2)
 where initial_price is null;

-- 2. The column can no longer invent a price.
alter table public.quotes drop column total;
alter table public.quotes
  add column total numeric(10,2)
  generated always as (initial_price + coalesce(travel_fee, (0)::numeric)) stored;

comment on column public.quotes.total is
  'GENERATED = initial_price + travel_fee. NULL when the quote has no price — deliberately NOT 0, because an unpriced quote is not a free one. It must never fall back to hours*crew_size*rate again: that fabricated a price the pricing engine never produced, and two customers were billed on it (see RUN-2026-07-16e).';