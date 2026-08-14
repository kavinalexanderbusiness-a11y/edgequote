-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260730063035
--   name    : booking_uploads_insert_allow_authenticated
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- Booking photo uploads were failing for any logged-in visitor. The booking page
-- (/book/[token]) uses the browser client, which carries whatever session exists,
-- so the owner testing their own link, staff, or a logged-in customer uploads as
-- role 'authenticated' — and the only INSERT policy on this bucket was anon-only,
-- so their upload hit a 403 RLS error and the photo was silently dropped (the
-- booking still arrived, without the photo). The read policy already covers both
-- roles; INSERT must too. Replaces the anon-only policy with a combined one.
drop policy if exists booking_uploads_anon_insert on storage.objects;
drop policy if exists booking_uploads_public_insert on storage.objects;
create policy booking_uploads_public_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'booking-uploads');