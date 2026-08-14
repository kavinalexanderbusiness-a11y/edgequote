-- ═══════════════════════════════════════════════════════════════════════════
-- Dispatch & Crew Management foundation (2026-07-15)
-- ✅ APPLIED to prod via MCP 2026-07-15 and verified (tables, policies,
--    triggers, publication, unique constraint all read back live).
--
-- Gives the scheduler a crew IDENTITY dimension. Until now "crew" meant only a
-- headcount integer (jobs.crew_size); routing/capacity assumed ONE sequential
-- route per day. These tables let a day be dispatched across named crews while
-- every existing engine (route ETAs, optimizer, capacity) keeps operating on
-- per-crew subsets of the same jobs table.
--
--   crews            — the named crew (color for board/map, optional capacity)
--   technicians      — people; home crew + a live status the owner flips
--   dispatch_notes   — one note per (date, crew); crew NULL = day-level note
--   jobs.crew_id     — which crew runs the visit (NULL = unassigned; the
--                      single-crew status quo is untouched)
--   equipment.crew_id— vehicles ARE equipment; assignment, not a new table
--
-- jobs.crew_size (headcount) stays orthogonal — it sizes labor, not identity.
-- Idempotent — safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── crews ────────────────────────────────────────────────────────────────────
create table if not exists public.crews (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  color       text not null default 'emerald',
  day_start   time,
  day_end     time,
  capacity_minutes integer,
  is_active   boolean not null default true,
  sort_order  integer not null default 0
);
comment on column public.crews.color is 'Palette key (lib/crews CREW_PALETTE) — board chips + map pin hues, not a hex.';
comment on column public.crews.capacity_minutes is 'Explicit daily capacity override; NULL = derive from day window / business default.';
comment on column public.crews.day_start is 'Crew-specific day start; NULL = business work_start_time.';

alter table public.crews enable row level security;
drop policy if exists "crews: select own" on public.crews;
drop policy if exists "crews: insert own" on public.crews;
drop policy if exists "crews: update own" on public.crews;
drop policy if exists "crews: delete own" on public.crews;
create policy "crews: select own" on public.crews for select using (auth.uid() = user_id);
create policy "crews: insert own" on public.crews for insert with check (auth.uid() = user_id);
create policy "crews: update own" on public.crews for update using (auth.uid() = user_id);
create policy "crews: delete own" on public.crews for delete using (auth.uid() = user_id);

drop trigger if exists crews_updated_at on public.crews;
create trigger crews_updated_at before update on public.crews
  for each row execute procedure public.handle_updated_at();

create index if not exists crews_user_idx on public.crews(user_id, is_active);

-- ── technicians ──────────────────────────────────────────────────────────────
create table if not exists public.technicians (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  crew_id     uuid references public.crews(id) on delete set null,
  name        text not null,
  phone       text,
  email       text,
  role        text,
  status      text not null default 'available'
              check (status in ('available','en_route','on_job','break','off')),
  status_changed_at timestamptz not null default now(),
  is_active   boolean not null default true
);
comment on column public.technicians.status is 'Live dispatch status, owner-flipped from the board (no field login yet).';

alter table public.technicians enable row level security;
drop policy if exists "technicians: select own" on public.technicians;
drop policy if exists "technicians: insert own" on public.technicians;
drop policy if exists "technicians: update own" on public.technicians;
drop policy if exists "technicians: delete own" on public.technicians;
create policy "technicians: select own" on public.technicians for select using (auth.uid() = user_id);
create policy "technicians: insert own" on public.technicians for insert with check (auth.uid() = user_id);
create policy "technicians: update own" on public.technicians for update using (auth.uid() = user_id);
create policy "technicians: delete own" on public.technicians for delete using (auth.uid() = user_id);

drop trigger if exists technicians_updated_at on public.technicians;
create trigger technicians_updated_at before update on public.technicians
  for each row execute procedure public.handle_updated_at();

create index if not exists technicians_user_idx on public.technicians(user_id, is_active);
create index if not exists technicians_crew_idx on public.technicians(crew_id);

-- ── dispatch_notes ───────────────────────────────────────────────────────────
create table if not exists public.dispatch_notes (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  crew_id     uuid references public.crews(id) on delete cascade,
  body        text not null default '',
  constraint dispatch_notes_day_crew_unique unique nulls not distinct (user_id, date, crew_id)
);
comment on table public.dispatch_notes is 'One note per (date, crew); crew NULL = the day-level note. Upsert on the unique constraint.';

alter table public.dispatch_notes enable row level security;
drop policy if exists "dispatch_notes: select own" on public.dispatch_notes;
drop policy if exists "dispatch_notes: insert own" on public.dispatch_notes;
drop policy if exists "dispatch_notes: update own" on public.dispatch_notes;
drop policy if exists "dispatch_notes: delete own" on public.dispatch_notes;
create policy "dispatch_notes: select own" on public.dispatch_notes for select using (auth.uid() = user_id);
create policy "dispatch_notes: insert own" on public.dispatch_notes for insert with check (auth.uid() = user_id);
create policy "dispatch_notes: update own" on public.dispatch_notes for update using (auth.uid() = user_id);
create policy "dispatch_notes: delete own" on public.dispatch_notes for delete using (auth.uid() = user_id);

drop trigger if exists dispatch_notes_updated_at on public.dispatch_notes;
create trigger dispatch_notes_updated_at before update on public.dispatch_notes
  for each row execute procedure public.handle_updated_at();

create index if not exists dispatch_notes_user_date_idx on public.dispatch_notes(user_id, date);

-- ── assignment columns on existing tables ────────────────────────────────────
alter table public.jobs add column if not exists crew_id uuid references public.crews(id) on delete set null;
comment on column public.jobs.crew_id is 'Which crew runs this visit. NULL = unassigned (single-crew default). Orthogonal to crew_size (headcount).';
create index if not exists jobs_crew_id_idx on public.jobs(crew_id);

alter table public.equipment add column if not exists crew_id uuid references public.crews(id) on delete set null;
comment on column public.equipment.crew_id is 'Crew this vehicle/equipment is assigned to for dispatch. NULL = unassigned pool.';
create index if not exists equipment_crew_idx on public.equipment(crew_id);

-- ── realtime: live dispatch board ────────────────────────────────────────────
alter table public.crews replica identity full;
alter table public.technicians replica identity full;
alter table public.dispatch_notes replica identity full;
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['crews','technicians','dispatch_notes'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
