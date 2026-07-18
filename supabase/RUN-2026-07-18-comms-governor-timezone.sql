-- ── MSG-1 send governor: owner timezone + daily-cap index ────────────────────
-- ✅ APPLIED to prod 2026-07-18 via MCP (migration comms_governor_timezone);
-- committed for the record — do not re-run destructively (both statements are
-- idempotent anyway).
--
-- Quiet hours need the OWNER's local hour. The automation engine proved this is
-- unknowable server-side (it shipped UTC-as-local — the always-open bug); the
-- governor refuses to guess and fails closed on unknown, so the column must
-- exist and be populated. Canada-first default; the founding business is in
-- Calgary. NOT NULL + DEFAULT means no real row can present an unknown timezone.

alter table public.business_settings
  add column if not exists timezone text not null default 'America/Edmonton';

-- The governor's owner-daily-cap count scans user_id + created_at.
create index if not exists notification_log_user_created_idx
  on public.notification_log using btree (user_id, created_at);
