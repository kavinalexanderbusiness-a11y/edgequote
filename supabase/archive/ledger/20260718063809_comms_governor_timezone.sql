-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260718063809
--   name    : comms_governor_timezone
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
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