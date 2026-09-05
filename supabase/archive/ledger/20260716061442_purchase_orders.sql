-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716061442
--   name    : purchase_orders
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.purchase_orders (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  supplier_id  uuid references public.suppliers(id) on delete restrict,
  po_number    text,
  status       text not null default 'draft',
  ordered_at   date,
  expected_at  date,
  notes        text,
  constraint purchase_orders_status_check check (status in ('draft','ordered','cancelled'))
);

alter table public.purchase_orders enable row level security;
drop policy if exists "purchase_orders: select own" on public.purchase_orders;
drop policy if exists "purchase_orders: insert own" on public.purchase_orders;
drop policy if exists "purchase_orders: update own" on public.purchase_orders;
drop policy if exists "purchase_orders: delete own" on public.purchase_orders;
create policy "purchase_orders: select own" on public.purchase_orders for select using (auth.uid() = user_id);
create policy "purchase_orders: insert own" on public.purchase_orders for insert with check (auth.uid() = user_id);
create policy "purchase_orders: update own" on public.purchase_orders for update using (auth.uid() = user_id);
create policy "purchase_orders: delete own" on public.purchase_orders for delete using (auth.uid() = user_id);

create index if not exists purchase_orders_user_idx on public.purchase_orders(user_id, created_at desc);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders(supplier_id) where supplier_id is not null;

create table if not exists public.purchase_order_items (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  part_id           uuid not null references public.parts(id) on delete restrict,
  qty_ordered       numeric not null default 0,
  unit_cost         numeric,
  notes             text
);

alter table public.purchase_order_items enable row level security;
drop policy if exists "purchase_order_items: select own" on public.purchase_order_items;
drop policy if exists "purchase_order_items: insert own" on public.purchase_order_items;
drop policy if exists "purchase_order_items: update own" on public.purchase_order_items;
drop policy if exists "purchase_order_items: delete own" on public.purchase_order_items;
create policy "purchase_order_items: select own" on public.purchase_order_items for select using (auth.uid() = user_id);
create policy "purchase_order_items: insert own" on public.purchase_order_items for insert with check (auth.uid() = user_id);
create policy "purchase_order_items: update own" on public.purchase_order_items for update using (auth.uid() = user_id);
create policy "purchase_order_items: delete own" on public.purchase_order_items for delete using (auth.uid() = user_id);

create index if not exists purchase_order_items_po_idx on public.purchase_order_items(purchase_order_id);
create index if not exists purchase_order_items_part_idx on public.purchase_order_items(part_id);

alter table public.part_movements
  add column if not exists purchase_order_item_id uuid
    references public.purchase_order_items(id) on delete cascade;

create index if not exists part_movements_po_item_idx
  on public.part_movements(purchase_order_item_id) where purchase_order_item_id is not null;

comment on column public.part_movements.purchase_order_item_id is
  'Receipt link. A kind=restock movement carrying this IS the receipt of that PO line; received qty is sum(qty) over these rows (lib/purchasing.receivedQty), never a stored column. CASCADE: deleting the line reverses the stock.';

comment on table public.purchase_order_items is
  'PO lines. qty_received is intentionally absent — it is derived from part_movements linked by purchase_order_item_id, so stock and receipts cannot drift apart.';