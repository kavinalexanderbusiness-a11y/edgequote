-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-09 — E-transfer email for the portal payment methods.
-- ONE source of truth on business_settings; the portal's "Ways to pay" panel
-- reads it through get_portal_data (no second settings location). Idempotent.
-- ════════════════════════════════════════════════════════════

alter table public.business_settings
  add column if not exists etransfer_email text;

-- Recreate get_portal_data with etransfer_email in the business projection
-- (same definition as 2026-07-07, one field added).
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️  SUPERSEDED — DO NOT RESTORE THIS BODY.  (INF-2, 2026-07-17)
--
--   get_portal_data now has exactly ONE definition:
--       supabase/CANONICAL-get_portal_data.sql
--
--   A complete, runnable OLDER copy stood here. Running this file replaced the
--   live function with it — silently, with no error — dropping
--   the `services` and `properties` keys.
--   Nothing failed; the portal just started returning less. That is why the
--   body is gone rather than merely commented "outdated".
--
--   Everything else in this file is UNCHANGED and still safe to run.
-- ══════════════════════════════════════════════════════════════════════════
grant execute on function public.get_portal_data(text) to anon, authenticated;
