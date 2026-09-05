-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717013442
--   name    : report_schedules
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists report_schedules (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('daily', 'weekly', 'monthly', 'yearly')),
  enabled     boolean not null default true,
  recipient   text,
  last_period_to date,
  last_sent_at   timestamptz,
  last_error  text,
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