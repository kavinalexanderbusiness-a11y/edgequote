-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15d — Parts inventory
--
-- Blades, oil, filters, belts. Two questions an operator can't answer today:
-- "do I have a blade for the 60in?" and "did we actually use the oil we bought?"
--
--   parts           — the part + its reorder policy
--   part_movements  — every stock change (restock in, use out, count correction)
--
-- Stock is DERIVED by a trigger from the movement ledger — never hand-written by
-- the app — the same rule equipment.last_service_at and the payment ledger
-- follow. A movement is the only way stock moves, so the count can't drift.
--
-- The link that makes this pay off: a 'use' movement carries
-- equipment_service_id ON DELETE CASCADE. Revert a service entry and its parts
-- return to stock automatically, with no app code involved.
--
-- Idempotent — safe to run more than once. Requires RUN-2026-07-15-equipment.sql.
-- ════════════════════════════════════════════════════════════

create table if not exists public.parts (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,                   -- "Toro 60in blade"
  sku          text,                            -- dealer part number
  category     text not null default 'other',   -- blade|oil|filter|spark_plug|belt|tire|fluid|other
  unit         text not null default 'each',    -- each | L | qt | kg
  -- DERIVED from part_movements by the trigger below — never written by app code.
  qty_on_hand  numeric not null default 0,
  reorder_at   numeric,                         -- low-stock threshold; null = not tracked
  unit_cost    numeric,                         -- what you pay per unit
  supplier     text,
  notes        text
);

alter table public.parts enable row level security;
drop policy if exists "parts: select own" on public.parts;
drop policy if exists "parts: insert own" on public.parts;
drop policy if exists "parts: update own" on public.parts;
drop policy if exists "parts: delete own" on public.parts;
create policy "parts: select own" on public.parts for select using (auth.uid() = user_id);
create policy "parts: insert own" on public.parts for insert with check (auth.uid() = user_id);
create policy "parts: update own" on public.parts for update using (auth.uid() = user_id);
create policy "parts: delete own" on public.parts for delete using (auth.uid() = user_id);

create index if not exists parts_user_idx on public.parts(user_id, category);

-- ── The movement ledger ──────────────────────────────────────────────────────
create table if not exists public.part_movements (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  part_id      uuid not null references public.parts(id) on delete cascade,
  kind         text not null default 'restock',  -- restock | use | adjust
  -- SIGNED: +in, −out. Stock is simply the sum, so the ledger explains itself.
  qty          numeric not null,
  unit_cost    numeric,                          -- cost at the time (restock)
  -- The service that consumed this part. CASCADE is the point: reverting a
  -- service entry returns its parts to stock with no application logic.
  equipment_service_id uuid references public.equipment_service(id) on delete cascade,
  notes        text
);

alter table public.part_movements enable row level security;
drop policy if exists "part_movements: select own" on public.part_movements;
drop policy if exists "part_movements: insert own" on public.part_movements;
drop policy if exists "part_movements: update own" on public.part_movements;
drop policy if exists "part_movements: delete own" on public.part_movements;
create policy "part_movements: select own" on public.part_movements for select using (auth.uid() = user_id);
create policy "part_movements: insert own" on public.part_movements for insert with check (auth.uid() = user_id);
create policy "part_movements: update own" on public.part_movements for update using (auth.uid() = user_id);
create policy "part_movements: delete own" on public.part_movements for delete using (auth.uid() = user_id);

create index if not exists part_movements_part_idx on public.part_movements(user_id, part_id, created_at desc);
create index if not exists part_movements_service_idx on public.part_movements(equipment_service_id);

-- ── Stock = the sum of the ledger (never trust app code to keep a running total) ──
create or replace function public.recompute_part_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_part uuid;
begin
  v_part := coalesce(new.part_id, old.part_id);
  update public.parts p
     set qty_on_hand = coalesce((select sum(qty) from public.part_movements where part_id = v_part), 0),
         updated_at  = now()
   where p.id = v_part;
  return null;
end $$;

drop trigger if exists part_movements_recompute on public.part_movements;
create trigger part_movements_recompute
after insert or update or delete on public.part_movements
for each row execute function public.recompute_part_stock();
