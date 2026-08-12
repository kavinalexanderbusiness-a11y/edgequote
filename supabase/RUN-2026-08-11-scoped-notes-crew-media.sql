-- ══════════════════════════════════════════════════════════════════════════════
-- SCOPED NOTES + CREW REFERENCE MEDIA V1
--
-- Three audiences — INTERNAL / CREW / CUSTOMER — and the rule that they never
-- leak into one another. See src/lib/noteScope.ts for the registry this file
-- backs, and verify:scoped-notes for the guard that holds it.
--
-- ⭐ THE MODEL IS ALREADY HERE, AND THIS FILE DOES NOT REPLACE IT.
-- The audience of a piece of text is a property of the COLUMN, decided once,
-- and enforced by which server-side projection selects it. invoices.notes
-- prints and invoices.internal_notes does not (2026-07-15). jobs.notes goes to
-- the phone, jobs.completion_summary goes to the customer, jobs.completion_issue
-- goes to neither (2026-08-11). ⛔ There is deliberately NO generic notes table
-- and NO `visibility` enum: a wrong enum value is one UPDATE away from
-- publishing a gate code, whereas a wrong column has to be added to
-- get_portal_data on purpose. Every audience bug this product has actually
-- shipped was fixed by SPLITTING A FIELD, never by adding a flag.
--
-- WHAT THIS FILE ADDS, AND ONLY THIS:
--   1. quotes.internal_notes — the one record with a customer-facing note and
--      NO private counterpart. Until now the owner's only box on a quote was
--      the one that prints.
--   2. crew_media — reference photos and video a worker needs BEFORE the work,
--      in a PRIVATE bucket, scoped to one visit.
--
-- ⛔ NOT PROOF OF WORK. job_photos + the public job-photos bucket stay exactly
-- what they are: the visual record of work DONE, some of which the customer is
-- meant to see. crew_media is the opposite direction — material the office
-- sends TO the field, which no customer ever receives. Same storage technology,
-- deliberately different table, deliberately different bucket, because the two
-- have opposite privacy defaults and merging them would give job_photos rows
-- that must never be resolved with getPublicUrl.
--
-- IDEMPOTENT. Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The quote's private half ─────────────────────────────────────────────
-- quotes.notes has ALWAYS been customer-facing: QuotePDF renders it in a "Notes"
-- box and get_portal_data selects it. 82 of 96 live quotes carry one and they
-- read exactly as intended — scope of work, in the customer's language.
--
-- ⚠️ THE TRAP THIS CLOSES. The owner-facing placeholder on that field read
-- "Job-specific details, access instructions, gate codes…" — an invitation to
-- type operational secrets into the one box on a quote that PRINTS. Nobody had
-- taken the invitation yet (all 5 keyword matches in production are legitimate
-- scope text using words like "accessible"), so this is a latent trap being
-- closed, not a live leak being cleaned up. The field keeps its meaning and its
-- data; the UI stops lying about it, and the owner finally gets somewhere else
-- to put "don't go below $700".
alter table public.quotes
  add column if not exists internal_notes text;

comment on column public.quotes.internal_notes is
  'INTERNAL ONLY. The owner''s private margin on this quote — price floor, who to call before changing scope, why it was priced this way. MUST NOT be selected by get_portal_data or rendered by any PDF. Its customer-facing counterpart is quotes.notes.';

comment on column public.quotes.notes is
  'CUSTOMER-VISIBLE. The scope note the customer reads — printed in QuotePDF''s Notes box and selected by get_portal_data. Never put a gate code or a price floor here; that is quotes.internal_notes.';

comment on column public.customers.notes is
  'INTERNAL ONLY. What the office knows about this customer. Absent from get_portal_data''s customer projection, which names its columns.';

-- ── 2. Crew reference media ─────────────────────────────────────────────────
-- One row per file. The `jobs` row IS the visit, so job_id alone answers "which
-- visit, which customer, which property" — customer_id/property_id are NOT
-- denormalised here (job_photos does, and has to, because it is also queried by
-- property across visits; this is only ever read one visit at a time).
--
-- ⛔ NO `visibility` COLUMN. The TABLE is the audience: everything in it is crew
-- reference material. A column offering 'customer' here would be a switch whose
-- only purpose is to leak, and Proof of Work already owns customer-facing
-- evidence via jobs.completion_summary + job_photos.
create table if not exists public.crew_media (
  id            uuid primary key default gen_random_uuid(),
  -- The BUSINESS that owns this file. Every RLS policy and every storage path
  -- starts here, and it is never inferred from a filename.
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- The work record. Cascade: deleting a visit takes its reference media with
  -- it and leaves no orphan rows pointing at objects nobody can reach.
  job_id        uuid not null references public.jobs(id) on delete cascade,
  storage_path  text not null unique,
  kind          text not null check (kind in ('photo', 'video')),
  mime          text,
  size_bytes    bigint,
  caption       text,
  -- Who put it there. The owner's auth uid, or a crew member's — both are real
  -- auth users under Crew Mode. Nullable because a future server-side importer
  -- may have no session, and an unknown uploader must not block the record.
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists crew_media_job_idx  on public.crew_media (job_id, created_at);
create index if not exists crew_media_user_idx on public.crew_media (user_id);

comment on table public.crew_media is
  'CREW AUDIENCE. Reference photos/video the office sends TO the field — what a worker needs BEFORE and DURING the work. Never customer-facing: no portal projection selects it. ⛔ Not proof of work — that is job_photos + jobs.completion_summary.';

alter table public.crew_media enable row level security;

-- The owner's access, in the shape all ~300 other policies use. A crew session
-- matches NONE of these and holds no table grants at all — Crew Mode's founding
-- rule — so a worker reaches this catalogue only through /api/crew/media, which
-- proves their assignment first.
drop policy if exists "crew_media: owner all" on public.crew_media;
create policy "crew_media: owner all" on public.crew_media
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 3. The private bucket ───────────────────────────────────────────────────
-- ⚠️ WHY NOT job-photos. That bucket is public:true — every object in it is
-- readable by anyone holding the URL, with no expiry and no session. That is a
-- deliberate, working choice for photos of finished work (the portal and the
-- PDFs render them), and a disqualifying one for a video of the customer's gate.
-- A private bucket is the ONLY thing that makes the URL stop being the
-- permission.
--
-- file_size_limit and allowed_mime_types are set ON THE BUCKET so the ceiling is
-- enforced by storage itself, not by a JS check a crafted request skips.
--   50 MB  — roughly 2-3 minutes of 1080p H.264. Enough to show a gate and a
--            mulch line; far short of "upload the whole morning".
--   MIME   — browser-playable video plus the image types a phone produces.
--            video/quicktime (.mov) is admitted because that is what an iPhone
--            records by default; it is NOT universally playable, and the player
--            says so rather than pretending (see CrewStopMedia).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'crew-media', 'crew-media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif',
        'video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update
  set public            = false,           -- re-assert on every run: this is THE property that matters
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Owner-scoped object policies, identical in shape to equipment-docs and
-- expense-receipts (the two private buckets that already work this way). Path is
-- <owner_user_id>/<job_id>/<random>.<ext>, so the first segment IS the tenant
-- boundary and Business A can neither read nor write under Business B's folder.
--
-- ⛔ There is deliberately NO crew policy here. A storage policy is per-OBJECT
-- and would have to re-derive "is this worker assigned to that visit" from a
-- path segment; the assignment check already exists, once, in the crew API
-- route, and a second copy in SQL is a second thing to get wrong. Crew reads are
-- served as short-lived signed URLs minted by that route AFTER it proves the
-- assignment — the same boundary /api/crew/photos already is for writes.
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
