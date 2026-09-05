-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715085430
--   name    : record_branding_bucket
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Repo record for the `branding` storage bucket (business logo). Transcribed from the
-- live bucket + policies; intended as a verified no-op against the current database.
insert into storage.buckets (id, name, public)
  values ('branding', 'branding', true)
  on conflict (id) do nothing;

drop policy if exists "branding read"   on storage.objects;
drop policy if exists "branding upload" on storage.objects;
drop policy if exists "branding update" on storage.objects;

create policy "branding read"   on storage.objects for select to authenticated
  using (bucket_id = 'branding');
create policy "branding upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding');
create policy "branding update" on storage.objects for update to authenticated
  using (bucket_id = 'branding');