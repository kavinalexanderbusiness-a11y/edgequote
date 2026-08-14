-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-16a — Purchase Orders + Receiving (Inventory milestone 2)
--
-- APPLIED + VERIFIED in production 2026-07-16 via Supabase MCP (migration
-- `purchase_orders`). The repo is the source of truth for this module's schema
-- (schema.sql defines neither equipment, parts nor part_movements — RUN files
-- only). Requires RUN-2026-07-15-parts.sql and RUN-2026-07-15-suppliers.sql.
--
--   purchase_orders       — what you ordered from a supplier
--   purchase_order_items  — the lines
--   part_movements.purchase_order_item_id — the receipt link
--
-- THERE IS NO SECOND STOCK SYSTEM HERE. Receiving inserts a
-- part_movements(kind='restock', qty=+n) row and stops. recompute_part_stock
-- then recomputes parts.qty_on_hand as sum(qty) — exactly as it already does for
-- 'use' and 'adjust'. Nothing in this migration or its app code writes
-- qty_on_hand.
--
-- ⚠️ qty_received IS DELIBERATELY NOT A COLUMN.
-- Storing "how much of this line arrived" next to a ledger that already knows
-- would create two answers to one question, and they WILL drift: a movement
-- deleted, a receipt reverted, a manual adjust — each moves stock without
-- touching the column. Received quantity is DERIVED as the sum of the movements
-- linked to the line (lib/purchasing.receivedQty). One source of truth, by
-- construction rather than by discipline.
--
-- Status follows the invoices pattern (lib/payments/ledger.displayInvoiceStatus):
--   STORED  status = draft | ordered | cancelled   — the workflow the owner drives
--   DERIVED overlay = partial | received           — computed from the ledger
-- so "received" can never disagree with the stock that actually arrived.
--
-- ON DELETE CASCADE on the movement link mirrors equipment_service_id exactly:
-- deleting a PO line reverses its receipt and stock returns, with no app code
-- involved — the same "revert a service returns its parts" behaviour parts
-- already ships.
--
-- One-location only. No warehouse column, no transfers, no location dimension —
-- the ledger stays exactly the shape it is today.
--
-- Idempotent — safe to run more than once.
-- ════════════════════════════════════════════════════════════

create table if not exists public.purchase_orders (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- RESTRICT: a PO is purchase history. Deleting a vendor must never silently
  -- erase what you bought from them — archive the supplier instead.
  supplier_id  uuid references public.suppliers(id) on delete restrict,
  po_number    text,                              -- your reference / their order no.
  status       text not null default 'draft',     -- draft | ordered | cancelled
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
  -- RESTRICT: deleting a part you have purchase history for would rewrite that
  -- history. The part is what the line is ABOUT.
  part_id           uuid not null references public.parts(id) on delete restrict,
  qty_ordered       numeric not null default 0,
  unit_cost         numeric,                       -- what THIS order paid
  notes             text
  -- NO qty_received. See the header: it is derived from part_movements.
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

-- THE receipt link. A restock movement carrying this id IS the receipt — there is
-- no other record of one. CASCADE so deleting the line reverses the stock, the
-- same contract equipment_service_id already has.
alter table public.part_movements
  add column if not exists purchase_order_item_id uuid
    references public.purchase_order_items(id) on delete cascade;

create index if not exists part_movements_po_item_idx
  on public.part_movements(purchase_order_item_id) where purchase_order_item_id is not null;

comment on column public.part_movements.purchase_order_item_id is
  'Receipt link. A kind=restock movement carrying this IS the receipt of that PO line; received qty is sum(qty) over these rows (lib/purchasing.receivedQty), never a stored column. CASCADE: deleting the line reverses the stock.';

comment on table public.purchase_order_items is
  'PO lines. qty_received is intentionally absent — it is derived from part_movements linked by purchase_order_item_id, so stock and receipts cannot drift apart.';
