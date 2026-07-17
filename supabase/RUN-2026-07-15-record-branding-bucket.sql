-- ── Repo record: the `branding` storage bucket ───────────────────────────────
--
-- WHY THIS FILE EXISTS
-- The `branding` bucket is LIVE IN PRODUCTION and holds the business logo that the
-- settings page uploads (src/app/dashboard/settings/page.tsx → handleLogoUpload) and
-- that every branded email renders from (business_settings.logo_url, threaded through
-- lib/comms/templates renderBody's email shell). No .sql file in the repo creates it.
-- It was made in the dashboard and never written down, so a rebuild from source
-- control produces a database where logo upload fails and branded email loses its
-- header image.
--
-- The other three buckets are recorded: job-photos (schema.sql), booking-uploads
-- (RUN-db-catchup-2026-06-25.sql), equipment-docs (RUN-2026-07-15-equipment-docs.sql).
-- This one was the last gap.
--
-- TRANSCRIBED, NOT DESIGNED. Everything below is read back from the live objects
-- (storage.buckets + pg_policies on storage.objects). Applying it against the current
-- database is a verified no-op.
--
-- ⚠️ RECORDED AS-IS, INCLUDING A SHARP EDGE — do not "fix" it in this file:
-- The three policies are granted to `authenticated` and gate on nothing but
-- `bucket_id = 'branding'`. They are NOT scoped to the owner's user_id, so any signed-in
-- user can read, overwrite or add objects in this bucket. There is also no DELETE
-- policy, so logos can be replaced but never removed. That is exactly how production
-- behaves today; this file's job is to make the repo able to reproduce it, not to
-- change it. Tightening the scope is a real (and probably wanted) behaviour change —
-- it needs the owner's decision and its own migration, because narrowing these
-- predicates could break existing logo reads/writes.
--
-- SAFETY: additive and idempotent. No drops of anything this file doesn't own.

-- Public bucket: logo URLs are embedded in outbound email, which cannot present an
-- auth header — the object has to be readable unauthenticated for the image to render.
insert into storage.buckets (id, name, public)
  values ('branding', 'branding', true)
  on conflict (id) do nothing;

-- drop-then-create by the exact policy names this file owns = re-runnable.
drop policy if exists "branding read"   on storage.objects;
drop policy if exists "branding upload" on storage.objects;
drop policy if exists "branding update" on storage.objects;

create policy "branding read"   on storage.objects for select to authenticated
  using (bucket_id = 'branding');
create policy "branding upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding');
create policy "branding update" on storage.objects for update to authenticated
  using (bucket_id = 'branding');
