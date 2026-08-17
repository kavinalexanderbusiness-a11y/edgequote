-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083542
--   name    : quote_addons_v1_restore_composite_fk_after_mutation_test
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restores the COMPOSITE tenancy foreign key after the deliberate mutation test.
-- ⭐ (user_id, quote_id) → quotes(user_id, id): "this extra belongs to THIS
-- tenant's quote" is a database fact, not a convention a screen remembers.
alter table public.quote_addons drop constraint quote_addons_quote_fkey;
alter table public.quote_addons add constraint quote_addons_quote_fkey
  foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete cascade;