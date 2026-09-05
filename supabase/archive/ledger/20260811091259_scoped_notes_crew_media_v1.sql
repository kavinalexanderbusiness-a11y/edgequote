-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811091259
--   name    : scoped_notes_crew_media_v1
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes
  add column if not exists internal_notes text;

comment on column public.quotes.internal_notes is
  'INTERNAL ONLY. The owner''s private margin on this quote — price floor, who to call before changing scope, why it was priced this way. MUST NOT be selected by get_portal_data or rendered by any PDF. Its customer-facing counterpart is quotes.notes.';

comment on column public.quotes.notes is
  'CUSTOMER-VISIBLE. The scope note the customer reads — printed in QuotePDF''s Notes box and selected by get_portal_data. Never put a gate code or a price floor here; that is quotes.internal_notes.';

comment on column public.customers.notes is
  'INTERNAL ONLY. What the office knows about this customer. Absent from get_portal_data''s customer projection, which names its columns.';

create table if not exists public.crew_media (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  storage_path  text not null unique,
  kind          text not null check (kind in ('photo', 'video')),
  mime          text,
  size_bytes    bigint,
  caption       text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists crew_media_job_idx  on public.crew_media (job_id, created_at);
create index if not exists crew_media_user_idx on public.crew_media (user_id);

comment on table public.crew_media is
  'CREW AUDIENCE. Reference photos/video the office sends TO the field — what a worker needs BEFORE and DURING the work. Never customer-facing: no portal projection selects it. Not proof of work — that is job_photos + jobs.completion_summary.';

alter table public.crew_media enable row level security;

drop policy if exists "crew_media: owner all" on public.crew_media;
create policy "crew_media: owner all" on public.crew_media
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'crew-media', 'crew-media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif',
        'video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update
  set public            = false,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "crew-media: owner reads own"   on storage.objects;
drop policy if exists "crew-media: owner inserts own" on storage.objects;
drop policy if exists "crew-media: owner updates own" on storage.objects;
drop policy if exists "crew-media: owner deletes own" on storage.objects;

create policy "crew-media: owner reads own" on storage.objects for select
  using (bucket_id = 'crew-media' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "crew-media: owner inserts own" on storage.objects for insert
  with check (bucket_id = 'crew-media' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "crew-media: owner updates own" on storage.objects for update
  using (bucket_id = 'crew-media' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "crew-media: owner deletes own" on storage.objects for delete
  using (bucket_id = 'crew-media' and (storage.foldername(name))[1] = (auth.uid())::text);