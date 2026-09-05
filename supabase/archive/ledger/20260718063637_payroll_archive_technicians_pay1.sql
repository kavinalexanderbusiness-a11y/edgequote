-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260718063637
--   name    : payroll_archive_technicians_pay1
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.technicians
  add column if not exists archived_at timestamptz;

comment on column public.technicians.archived_at is
  'Soft-archive: set when the technician leaves the roster (hidden everywhere, record preserved). NULL = active. Removing a technician must archive, never delete — their time_entries/wage_history/pto_entries are statutory records.';

create index if not exists technicians_active_idx
  on public.technicians (user_id)
  where archived_at is null;

alter table public.time_entries alter column technician_id drop not null;
alter table public.wage_history alter column technician_id drop not null;
alter table public.pto_entries  alter column technician_id drop not null;

alter table public.time_entries
  drop constraint if exists time_entries_technician_same_owner;
alter table public.time_entries
  add constraint time_entries_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

alter table public.wage_history
  drop constraint if exists wage_history_technician_same_owner;
alter table public.wage_history
  add constraint wage_history_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

alter table public.pto_entries
  drop constraint if exists pto_entries_technician_same_owner;
alter table public.pto_entries
  add constraint pto_entries_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);