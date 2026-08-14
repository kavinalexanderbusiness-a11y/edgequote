-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15c — Equipment documents
--
-- The warranty feature can tell you a machine is covered; this is where the
-- PROOF lives — the warranty certificate, the purchase receipt, the manual.
-- "Where's the receipt for the mower?" stops being a shoebox question.
--
-- Unlike job-photos (public, customers see them), these are private business
-- records: the bucket is PRIVATE and the app reads them through short-lived
-- signed URLs. Files are foldered by owner id, the same shape job-photos uses.
--
-- Idempotent — safe to run more than once. Requires RUN-2026-07-15-equipment.sql.
-- ════════════════════════════════════════════════════════════

-- ── Private bucket ───────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('equipment-docs', 'equipment-docs', false)
on conflict (id) do nothing;

-- Owner-scoped by the first path segment (…/<user_id>/<equipment_id>/<file>).
-- No public select policy — reads go through signed URLs only.
drop policy if exists "equipment-docs: read own"   on storage.objects;
drop policy if exists "equipment-docs: insert own" on storage.objects;
drop policy if exists "equipment-docs: update own" on storage.objects;
drop policy if exists "equipment-docs: delete own" on storage.objects;
create policy "equipment-docs: read own" on storage.objects for select
  using (bucket_id = 'equipment-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "equipment-docs: insert own" on storage.objects for insert
  with check (bucket_id = 'equipment-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "equipment-docs: update own" on storage.objects for update
  using (bucket_id = 'equipment-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "equipment-docs: delete own" on storage.objects for delete
  using (bucket_id = 'equipment-docs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── The document record ──────────────────────────────────────────────────────
create table if not exists public.equipment_docs (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  equipment_id uuid not null references public.equipment(id) on delete cascade,
  -- Storage object path inside the equipment-docs bucket.
  path         text not null,
  name         text not null,                  -- original filename, shown to the owner
  kind         text not null default 'other',  -- receipt|warranty|manual|insurance|photo|other
  mime         text,
  size_bytes   bigint
);

alter table public.equipment_docs enable row level security;
drop policy if exists "equipment_docs: select own" on public.equipment_docs;
drop policy if exists "equipment_docs: insert own" on public.equipment_docs;
drop policy if exists "equipment_docs: update own" on public.equipment_docs;
drop policy if exists "equipment_docs: delete own" on public.equipment_docs;
create policy "equipment_docs: select own" on public.equipment_docs for select using (auth.uid() = user_id);
create policy "equipment_docs: insert own" on public.equipment_docs for insert with check (auth.uid() = user_id);
create policy "equipment_docs: update own" on public.equipment_docs for update using (auth.uid() = user_id);
create policy "equipment_docs: delete own" on public.equipment_docs for delete using (auth.uid() = user_id);

create index if not exists equipment_docs_eq_idx on public.equipment_docs(user_id, equipment_id, created_at desc);
