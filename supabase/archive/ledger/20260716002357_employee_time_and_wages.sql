-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716002357
--   name    : employee_time_and_wages
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Wage + employment dates on the EXISTING employee record (technicians).
alter table public.technicians
  add column if not exists hourly_wage numeric(10,2),
  add column if not exists hired_on    date,
  add column if not exists ended_on    date;

comment on column public.technicians.hourly_wage is
  'Default pay rate for the NEXT clock-in. Historical cost lives on time_entries.hourly_rate (snapshot) — changing this never rewrites past shifts.';

do $$ begin
  alter table public.technicians add constraint technicians_hourly_wage_nonneg
    check (hourly_wage is null or hourly_wage >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.technicians add constraint technicians_employment_dates_ordered
    check (ended_on is null or hired_on is null or ended_on >= hired_on);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.technicians add constraint technicians_id_user_key
    unique (id, user_id);
exception when duplicate_object then null; end $$;

-- time_entries — THE paid-time ledger.
create table if not exists public.time_entries (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  technician_id  uuid not null,
  job_id         uuid references public.jobs(id) on delete set null,
  clock_in       timestamptz not null default now(),
  clock_out      timestamptz,
  break_minutes  int not null default 0,
  hourly_rate    numeric(10,2),
  notes          text,

  constraint time_entries_clock_order
    check (clock_out is null or clock_out > clock_in),
  constraint time_entries_break_nonneg
    check (break_minutes >= 0),
  constraint time_entries_rate_nonneg
    check (hourly_rate is null or hourly_rate >= 0),
  constraint time_entries_technician_same_owner
    foreign key (technician_id, user_id)
    references public.technicians (id, user_id) on delete cascade,

  minutes_worked int generated always as (
    case when clock_out is null then null
         else greatest(0, (extract(epoch from (clock_out - clock_in)) / 60)::int - break_minutes)
    end
  ) stored
);

comment on table public.time_entries is
  'THE paid-time ledger. One row per shift. minutes_worked is DB-derived; hourly_rate is snapshotted at clock-in so wage changes never rewrite history. Open shift = clock_out IS NULL (at most one per technician, enforced by index).';

create unique index if not exists time_entries_one_open_per_tech
  on public.time_entries (technician_id) where clock_out is null;

create index if not exists time_entries_user_idx on public.time_entries(user_id, clock_in desc);
create index if not exists time_entries_tech_idx on public.time_entries(technician_id, clock_in desc);
create index if not exists time_entries_job_idx  on public.time_entries(job_id);

alter table public.time_entries enable row level security;

drop policy if exists "time_entries: select own" on public.time_entries;
drop policy if exists "time_entries: insert own" on public.time_entries;
drop policy if exists "time_entries: update own" on public.time_entries;
drop policy if exists "time_entries: delete own" on public.time_entries;
create policy "time_entries: select own" on public.time_entries for select using (auth.uid() = user_id);
create policy "time_entries: insert own" on public.time_entries for insert with check (auth.uid() = user_id);
create policy "time_entries: update own" on public.time_entries for update using (auth.uid() = user_id);
create policy "time_entries: delete own" on public.time_entries for delete using (auth.uid() = user_id);

drop trigger if exists time_entries_updated_at on public.time_entries;
create trigger time_entries_updated_at before update on public.time_entries
  for each row execute procedure public.handle_updated_at();

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['time_entries'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;