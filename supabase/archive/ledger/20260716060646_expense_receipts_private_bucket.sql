-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716060646
--   name    : expense_receipts_private_bucket
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Expense receipts — private storage. Mirrors RUN-2026-07-16-expense-receipts-bucket.sql
-- Additive + idempotent. No table is altered.

insert into storage.buckets (id, name, public)
values ('expense-receipts', 'expense-receipts', false)
on conflict (id) do nothing;

drop policy if exists "expense-receipts: read own"   on storage.objects;
drop policy if exists "expense-receipts: insert own" on storage.objects;
drop policy if exists "expense-receipts: update own" on storage.objects;
drop policy if exists "expense-receipts: delete own" on storage.objects;

create policy "expense-receipts: read own" on storage.objects for select
  using (bucket_id = 'expense-receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "expense-receipts: insert own" on storage.objects for insert
  with check (bucket_id = 'expense-receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "expense-receipts: update own" on storage.objects for update
  using (bucket_id = 'expense-receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "expense-receipts: delete own" on storage.objects for delete
  using (bucket_id = 'expense-receipts' and (storage.foldername(name))[1] = auth.uid()::text);