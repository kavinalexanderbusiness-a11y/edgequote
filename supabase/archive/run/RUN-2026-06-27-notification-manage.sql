-- RUN-2026-06-27-notification-manage.sql
-- Snooze + dismiss/archive for in-app notifications. Additive, idempotent,
-- backward compatible — the app degrades gracefully (hides snooze/dismiss) until
-- this is applied, so it can ship before the migration runs.

alter table public.notifications
  add column if not exists snoozed_until timestamptz,   -- hidden until this time ("remind me later")
  add column if not exists archived_at   timestamptz;   -- dismissed/archived (hidden from the feed)

-- Fast "active feed" read: a user's non-archived notifications, newest first.
create index if not exists notifications_user_active_idx
  on public.notifications (user_id, created_at desc)
  where archived_at is null;
