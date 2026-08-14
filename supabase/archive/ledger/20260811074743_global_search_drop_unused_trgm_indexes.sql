-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811074743
--   name    : global_search_drop_unused_trgm_indexes
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Measured, not assumed. EXPLAIN on the shapes search_records actually issues shows
-- the planner choosing <table>_user_id_idx and filtering the ilike within that one
-- business's rows — the correct plan for a multi-tenant book, where the tenant
-- predicate is the selective one. A GIN trigram index is only chosen for a SINGLE
-- column ilike (invoices_inum_trgm is, and stays); across a multi-column OR it never
-- is. Keeping five unchosen GIN indexes would cost write amplification on every
-- customer, property, quote and invoice write to buy nothing.
drop index if exists public.customers_address_trgm;
drop index if exists public.customers_email_trgm;
drop index if exists public.properties_address_trgm;
drop index if exists public.invoices_cname_trgm;
drop index if exists public.quotes_cname_trgm;