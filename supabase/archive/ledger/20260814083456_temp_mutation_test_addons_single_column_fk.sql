-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083456
--   name    : temp_mutation_test_addons_single_column_fk
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ⚠️ MUTATION TEST — replaces the composite tenancy FK with a single-column one,
-- so one tenant could hang a priced extra on another tenant's quote.
-- RESTORED by the next migration.
alter table public.quote_addons drop constraint quote_addons_quote_fkey;
alter table public.quote_addons add constraint quote_addons_quote_fkey
  foreign key (quote_id) references public.quotes(id) on delete cascade;