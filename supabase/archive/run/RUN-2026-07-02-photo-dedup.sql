-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-02 — Durable photo duplicate detection.
-- Adds a content hash (8×8 average hash, 16 hex chars, computed client-side at
-- upload) to the photo catalogue so "did I already upload this shot?" survives
-- reloads and sessions. Backfill impossible client-side (hash needs pixels), so
-- old rows stay null — matching degrades to capture-timestamp for them.
-- Idempotent; safe to re-run. App code feature-detects the column and works
-- without it (session-only dedup) until this is applied.
-- ════════════════════════════════════════════════════════════

alter table public.job_photos
  add column if not exists content_hash text;

-- Dedup lookups are "this user's photos on this property with a hash".
create index if not exists job_photos_hash_idx
  on public.job_photos(user_id, property_id, content_hash)
  where content_hash is not null;
