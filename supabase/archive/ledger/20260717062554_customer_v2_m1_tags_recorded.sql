-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717062554
--   name    : customer_v2_m1_tags_recorded
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- customers.tags existed in production but was never recorded in any RUN file
-- (added out-of-band; caught in Customer V2 review). Idempotent no-op here —
-- its purpose is the migration ledger: the repo can now rebuild what prod is.
alter table public.customers
  add column if not exists tags text[] not null default '{}';