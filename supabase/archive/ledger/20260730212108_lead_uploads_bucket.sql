-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260730212108
--   name    : lead_uploads_bucket
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Storage for website contact/quote-form attachments (images + PDFs). The public
-- form posts each file as base64 in the JSON payload; the intake pipeline uploads
-- them here (server-side, service role) and persists the resulting public URLs so
-- the dashboard can show them and the owner email can link them. Before this, the
-- base64 rotted inertly inside website_leads.raw_submission — never surfaced.
--
-- PUBLIC READ (owner dashboard <img> + email links), but NO public INSERT: unlike
-- booking-uploads, the browser never writes here directly (it posts base64 to the
-- server), so only the service role writes — anonymous visitors cannot dump files
-- into a lead bucket.
insert into storage.buckets (id, name, public) values ('lead-uploads', 'lead-uploads', true)
  on conflict (id) do nothing;
drop policy if exists "lead_uploads_public_read" on storage.objects;
create policy "lead_uploads_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'lead-uploads');