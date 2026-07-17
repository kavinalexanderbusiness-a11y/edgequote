-- ── Scheduled reports ────────────────────────────────────────────────────────
-- One row per (owner, cadence). The owner turns a cadence on; the cron sends the
-- period that has just CLOSED and records which one it sent.
--
-- Applied to prod 2026-07-16 via MCP apply_migration (name: report_schedules).

create table if not exists report_schedules (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  kind        text not null check (kind in ('daily', 'weekly', 'monthly', 'yearly')),
  enabled     boolean not null default true,

  -- NULL = send to business_settings.email_primary. Storing a copy of that address
  -- here would silently keep mailing the old one after the owner changes it in
  -- Settings; a NULL that defers is a pointer, and a pointer can't go stale.
  recipient   text,

  -- ── THE idempotency key ──────────────────────────────────────────────────
  -- The `to` date of the last period actually sent, NOT "when did we last run".
  --
  -- The cron fires daily, but a weekly report must go out once. Keying on a
  -- timestamp ("was the last send > 7 days ago?") drifts: an hour's delay in one
  -- run pushes every later run later, and a retry after a failure double-sends.
  -- Keying on the PERIOD is exact — the week of Jul 5–11 is sent when
  -- last_period_to <> '2026-07-11', which is true exactly once, no matter how
  -- often the cron runs, and self-heals if a day is missed (the next run still
  -- sees the unsent period and sends it).
  last_period_to date,
  last_sent_at   timestamptz,

  -- Why the last attempt failed, for the owner to see. NULL once one succeeds.
  last_error  text,

  -- One schedule per cadence per owner. A UNIQUE constraint rather than an app
  -- check: two "daily" rows would mean two emails every morning, and the DB is the
  -- only place that can actually refuse it.
  unique (user_id, kind)
);

create index if not exists report_schedules_due_idx
  on report_schedules (enabled, kind)
  where enabled;

alter table report_schedules enable row level security;

drop policy if exists report_schedules_select_own on report_schedules;
create policy report_schedules_select_own on report_schedules
  for select using (auth.uid() = user_id);

drop policy if exists report_schedules_insert_own on report_schedules;
create policy report_schedules_insert_own on report_schedules
  for insert with check (auth.uid() = user_id);

drop policy if exists report_schedules_update_own on report_schedules;
create policy report_schedules_update_own on report_schedules
  for update using (auth.uid() = user_id);

drop policy if exists report_schedules_delete_own on report_schedules;
create policy report_schedules_delete_own on report_schedules
  for delete using (auth.uid() = user_id);

drop trigger if exists trg_report_schedules_updated_at on report_schedules;
create trigger trg_report_schedules_updated_at
  before update on report_schedules
  for each row execute function set_updated_at();

comment on table report_schedules is
  'Scheduled report cadences per owner. last_period_to is the idempotency key: the cron sends a closed period exactly once, however often it runs.';
comment on column report_schedules.last_period_to is
  'The `to` date of the last period SENT. Keyed on the period, not the clock, so retries and missed runs cannot double-send or drift.';
comment on column report_schedules.recipient is
  'NULL = defer to business_settings.email_primary (a pointer cannot go stale).';
