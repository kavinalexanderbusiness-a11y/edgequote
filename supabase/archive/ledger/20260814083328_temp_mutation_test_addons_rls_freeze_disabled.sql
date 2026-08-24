-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083328
--   name    : temp_mutation_test_addons_rls_freeze_disabled
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ⚠️ MUTATION TEST — drops the status predicate from the extras' RLS policies,
-- so a client could rewrite an APPROVED quote's extras. RESTORED next migration.
drop policy if exists "quote_addons: update own" on public.quote_addons;
create policy "quote_addons: update own" on public.quote_addons
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "quote_addons: insert own" on public.quote_addons;
create policy "quote_addons: insert own" on public.quote_addons
  for insert with check (auth.uid() = user_id);

drop policy if exists "quote_addons: delete own" on public.quote_addons;
create policy "quote_addons: delete own" on public.quote_addons
  for delete using (auth.uid() = user_id);