-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811083921
--   name    : job_cost_tenancy_composite_fks
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.jobs'::regclass and conname = 'jobs_id_user_key'
  ) then
    alter table public.jobs add constraint jobs_id_user_key unique (id, user_id);
  end if;
end $$;

alter table public.expenses drop constraint if exists expenses_job_id_fkey;
alter table public.expenses drop constraint if exists expenses_job_same_owner;
alter table public.expenses
  add constraint expenses_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete set null (job_id)
  not valid;
alter table public.expenses validate constraint expenses_job_same_owner;

alter table public.time_entries drop constraint if exists time_entries_job_id_fkey;
alter table public.time_entries drop constraint if exists time_entries_job_same_owner;
alter table public.time_entries
  add constraint time_entries_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete set null (job_id)
  not valid;
alter table public.time_entries validate constraint time_entries_job_same_owner;

alter table public.job_line_items drop constraint if exists job_line_items_job_id_fkey;
alter table public.job_line_items drop constraint if exists job_line_items_job_same_owner;
alter table public.job_line_items
  add constraint job_line_items_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete cascade
  not valid;
alter table public.job_line_items validate constraint job_line_items_job_same_owner;