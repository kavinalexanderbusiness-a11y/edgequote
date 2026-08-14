-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260718063809
--   name    : comms_governor_timezone
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

-- MSG-1 send governor: quiet hours need the OWNER's local hour, which was
-- proven unknowable server-side (the automation engine shipped this exact bug —
-- UTC hour passed as local). Canada-first default; the founding business is in
-- Calgary. NOT NULL + DEFAULT so the governor never meets an unknown timezone
-- on a real row (unknown fails closed for commercial sends).
alter table public.business_settings
  add column if not exists timezone text not null default 'America/Edmonton';

-- The governor's owner-daily-cap count scans user_id + created_at.
create index if not exists notification_log_user_created_idx
  on public.notification_log using btree (user_id, created_at);