-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083359
--   name    : quote_addons_v1_restore_rls_after_mutation_test
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restores the extras' RLS policies after the deliberate mutation test above.
-- Byte-identical to quote_addons_v1_schema. ⭐ The status predicate is here AND
-- in quote_addons_write_guard on purpose: RLS covers the client, the trigger
-- covers every SECURITY DEFINER path that bypasses it. Mutation-testing removed
-- each in turn and the other held — which is what defence in depth has to mean.
drop policy if exists "quote_addons: insert own" on public.quote_addons;
create policy "quote_addons: insert own" on public.quote_addons
  for insert with check (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')));

drop policy if exists "quote_addons: update own" on public.quote_addons;
create policy "quote_addons: update own" on public.quote_addons
  for update using (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')))
  with check (auth.uid() = user_id);

drop policy if exists "quote_addons: delete own" on public.quote_addons;
create policy "quote_addons: delete own" on public.quote_addons
  for delete using (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')));