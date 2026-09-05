-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717054703
--   name    : customer_v2_m1_primary_index_and_attribution
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- RUN-2026-07-16-customer-v2-m1.sql
-- Customer V2, migration 1 of the M0–M4 plan: constraints + safe attribution.
-- ADDITIVE ONLY. No column is dropped, no value overwritten, no data invented.
--
-- 1. "Exactly one primary property per customer" becomes a DATABASE constraint
--    instead of an app-side habit (DB constraints over app logic). Live data
--    already satisfies it (verified: 0 customers with two primaries).
create unique index if not exists properties_one_primary
  on public.properties(customer_id) where is_primary;

-- 2. Measurement attribution, ONLY where truth is derivable. Of 31 unattributed
--    measurements, 30 are PROSPECT measurements (no customer) — attributing them
--    would invent data, so they stay null on purpose. Exactly one belongs to a
--    customer with exactly one property; that one is safe.
update public.measurements m
   set property_id = (select p.id from public.properties p where p.customer_id = m.customer_id)
 where m.property_id is null
   and m.customer_id is not null
   and (select count(*) from public.properties p where p.customer_id = m.customer_id) = 1;