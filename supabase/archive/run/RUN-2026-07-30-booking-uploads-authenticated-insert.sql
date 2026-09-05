-- RUN-2026-07-30-booking-uploads-authenticated-insert.sql
-- APPLIED to prod 2026-07-30 (migration: booking_uploads_insert_allow_authenticated).
--
-- PRODUCTION BUG: booking-form submissions that include a photo lost the photo.
--
-- The public booking funnel (/book/[token]) uploads photos straight from the
-- browser to the `booking-uploads` storage bucket, then passes the URLs to
-- submit_booking. The browser client carries whatever Supabase session exists, so
-- the visitor's role is:
--   • 'anon'          — a real, logged-out customer          → upload allowed
--   • 'authenticated' — the OWNER testing their own booking link, staff, or a
--                       logged-in customer                   → upload 403'd
-- because the bucket's only INSERT policy (booking_uploads_anon_insert) was scoped
-- to `anon`. The read policy already covered {anon, authenticated}; INSERT did not.
--
-- Effect: for any authenticated visitor the upload failed with an RLS violation.
-- The client treats a failed upload as best-effort, so the booking still arrived —
-- WITHOUT the photo. Across the bucket's whole lifetime: 0 objects, 26 bookings via
-- the door, 0 with photos. Proven with SET ROLE probes: anon insert ok,
-- authenticated insert = "new row violates row-level security policy".
--
-- FIX: INSERT must allow both roles, exactly like SELECT already does. Replace the
-- anon-only policy with a combined one. No data change; strictly broadens who may
-- upload booking photos, in the direction the surface is already public.
-- Idempotent.

drop policy if exists "booking_uploads_anon_insert"   on storage.objects;
drop policy if exists "booking_uploads_public_insert"  on storage.objects;
create policy "booking_uploads_public_insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'booking-uploads');
