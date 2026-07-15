-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15 — Equipment tracking
--
-- A lawn-care operator runs tens of thousands of dollars of machines and today
-- EdgeQuote knows nothing about them: when the mower is due for an oil change,
-- which trimmer is in the shop, or what a machine has actually cost to own.
--
-- Two owner-scoped tables:
--   equipment          — the machine + its service policy (every N hours / N days)
--   equipment_service  — the maintenance log (one row per service performed)
--
-- "Last serviced" is DERIVED by a trigger from the log, never hand-maintained by
-- the app — the same DB-constraint-over-app-logic rule the payment ledger uses,
-- so logging/removing a service can't leave the machine's due-date wrong.
--
-- Idempotent — safe to run more than once.
-- ════════════════════════════════════════════════════════════

-- ── The machine ──────────────────────────────────────────────────────────────
create table if not exists public.equipment (
  id                     uuid primary key default uuid_generate_v4(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  name                   text not null,                    -- "Toro 60in Zero-Turn"
  category               text not null default 'other',    -- mower|trimmer|blower|aerator|truck|trailer|other
  make                   text,
  model                  text,
  serial_number          text,
  purchase_date          date,
  purchase_price         numeric,
  status                 text not null default 'active',   -- active|repair|retired
  -- Current engine hours (odometer-style; the owner bumps it as they run it).
  hours                  numeric not null default 0,
  -- Service policy: whichever comes first. Null = not tracked on that axis.
  service_interval_hours integer,
  service_interval_days  integer,
  -- DERIVED from equipment_service by the trigger below — never written by app code.
  last_service_at        date,
  last_service_hours     numeric,
  notes                  text
);

alter table public.equipment enable row level security;
drop policy if exists "equipment: select own" on public.equipment;
drop policy if exists "equipment: insert own" on public.equipment;
drop policy if exists "equipment: update own" on public.equipment;
drop policy if exists "equipment: delete own" on public.equipment;
create policy "equipment: select own" on public.equipment for select using (auth.uid() = user_id);
create policy "equipment: insert own" on public.equipment for insert with check (auth.uid() = user_id);
create policy "equipment: update own" on public.equipment for update using (auth.uid() = user_id);
create policy "equipment: delete own" on public.equipment for delete using (auth.uid() = user_id);

create index if not exists equipment_user_idx   on public.equipment(user_id, status);

-- ── The maintenance log ──────────────────────────────────────────────────────
create table if not exists public.equipment_service (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  equipment_id  uuid not null references public.equipment(id) on delete cascade,
  service_date  date not null default current_date,
  kind          text not null default 'other',  -- oil|blade|filter|spark_plug|tune_up|tire|repair|other
  hours         numeric,                        -- engine hours at time of service
  cost          numeric,
  notes         text
);

alter table public.equipment_service enable row level security;
drop policy if exists "equipment_service: select own" on public.equipment_service;
drop policy if exists "equipment_service: insert own" on public.equipment_service;
drop policy if exists "equipment_service: update own" on public.equipment_service;
drop policy if exists "equipment_service: delete own" on public.equipment_service;
create policy "equipment_service: select own" on public.equipment_service for select using (auth.uid() = user_id);
create policy "equipment_service: insert own" on public.equipment_service for insert with check (auth.uid() = user_id);
create policy "equipment_service: update own" on public.equipment_service for update using (auth.uid() = user_id);
create policy "equipment_service: delete own" on public.equipment_service for delete using (auth.uid() = user_id);

create index if not exists equipment_service_eq_idx on public.equipment_service(user_id, equipment_id, service_date desc);

-- ── Derive "last serviced" from the log (never trust app code to keep it) ─────
-- Recomputes from the most recent log row after any insert/update/delete, so the
-- machine's due-date can't drift when an entry is edited or reverted.
create or replace function public.recompute_equipment_service()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_eq uuid;
begin
  v_eq := coalesce(new.equipment_id, old.equipment_id);
  update public.equipment e
     set last_service_at    = s.service_date,
         last_service_hours = s.hours,
         updated_at         = now()
    from (
      select service_date, hours
        from public.equipment_service
       where equipment_id = v_eq
       order by service_date desc, created_at desc
       limit 1
    ) s
   where e.id = v_eq;
  -- No log rows left → clear the derived fields.
  if not exists (select 1 from public.equipment_service where equipment_id = v_eq) then
    update public.equipment set last_service_at = null, last_service_hours = null, updated_at = now() where id = v_eq;
  end if;
  return null;
end $$;

drop trigger if exists equipment_service_recompute on public.equipment_service;
create trigger equipment_service_recompute
after insert or update or delete on public.equipment_service
for each row execute function public.recompute_equipment_service();
