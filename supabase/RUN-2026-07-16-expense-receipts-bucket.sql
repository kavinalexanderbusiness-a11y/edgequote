-- ══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-16 — Expense receipts (private storage)
--
-- ✅ APPLIED + VERIFIED IN PROD 2026-07-16 via MCP (migration
-- `expense_receipts_private_bucket`). Verified after apply: bucket exists and is
-- PRIVATE, all 4 owner-scoped policies present, and equipment-docs' own 4 policies
-- intact (the drop-if-exists statements below are name-scoped, not bucket-wide).
-- This file is the repo's record of what ran — there is no migration ledger here,
-- so without it the repo silently disagrees with production about the schema.
--
-- `expenses.receipt_path` already exists (RUN-2026-07-15-accounting-foundation.sql).
-- This is the bucket it points INTO, plus the policies that make a receipt readable
-- by exactly one person: the owner who filed it.
--
-- WHY ITS OWN BUCKET, not equipment-docs (the other private bucket):
-- the path is both the access rule and the retention story. Receipts are tax
-- records — CRA expects them kept ~6 years — while equipment-docs holds manuals and
-- warranties. Mixing them means any future lifecycle rule, export or purge written
-- for one silently catches the other. Same mechanism, same policy shape, honest name.
--
-- PRIVATE (public=false): a receipt shows what the business bought, where and when.
-- Reads go through short-lived signed URLs (lib/accounting/receipts.ts) — there is
-- deliberately NO public select policy.
--
-- Additive + idempotent. Safe to re-run. No table is altered.
-- ══════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('expense-receipts', 'expense-receipts', false)
on conflict (id) do nothing;

-- Owner-scoped by the first path segment (…/<user_id>/<expense_id>/<file>) — the
-- exact shape equipment-docs and job-photos use, so there is one folder rule in
-- this codebase rather than three.
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
