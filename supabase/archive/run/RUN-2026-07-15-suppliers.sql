-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15e — Suppliers (Inventory module, milestone 1)
--
-- APPLIED + VERIFIED in production 2026-07-15 via Supabase MCP (migration
-- `suppliers`). Kept here because the repo is the source of truth for schema.
--
-- `parts.supplier` is TEXT — a name typed onto each part. That answers "who do I
-- buy this from" and nothing else: no phone number to call, no account number to
-- quote, no way to ask "what do I buy from this vendor" or "what did I spend
-- with them". Purchase orders need a real counterparty, so the vendor becomes an
-- entity.
--
--   suppliers          — the vendor
--   parts.supplier_id  — the part's vendor (nullable)
--
-- BACKWARDS COMPATIBILITY IS THE POINT OF THIS DESIGN:
--   * `parts.supplier` (text) is NOT dropped and NOT migrated. Existing rows keep
--     working and keep displaying exactly as they do today.
--   * supplier_id is nullable. A part with neither is fine.
--   * The app resolves the display name as: supplier_id -> suppliers.name, else
--     the legacy text. ONE resolver (lib/suppliers.supplierLabel) so the two
--     sources can never disagree on screen.
--   * Backfilling text -> rows would invent vendors the owner never created and
--     silently merge "Home Depot" with "home depot". Left alone deliberately;
--     the owner links parts to suppliers when they choose to.
--
-- Deliberately NOT here: no stock columns, no counts, no location. Stock stays
-- derived from part_movements by recompute_part_stock. A supplier is a
-- counterparty, not an inventory system.
--
-- Idempotent — safe to run more than once. Requires RUN-2026-07-15-parts.sql.
-- ════════════════════════════════════════════════════════════

create table if not exists public.suppliers (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,                 -- "Prairie Turf Equipment"
  contact_name   text,
  phone          text,
  email          text,
  website        text,
  account_number text,                          -- your account with them
  address        text,
  notes          text,
  -- Archived, never deleted: a supplier is referenced by parts (and, from
  -- milestone 2, by purchase orders). Hiding it must not rewrite history.
  archived_at    timestamptz
);

alter table public.suppliers enable row level security;
drop policy if exists "suppliers: select own" on public.suppliers;
drop policy if exists "suppliers: insert own" on public.suppliers;
drop policy if exists "suppliers: update own" on public.suppliers;
drop policy if exists "suppliers: delete own" on public.suppliers;
create policy "suppliers: select own" on public.suppliers for select using (auth.uid() = user_id);
create policy "suppliers: insert own" on public.suppliers for insert with check (auth.uid() = user_id);
create policy "suppliers: update own" on public.suppliers for update using (auth.uid() = user_id);
create policy "suppliers: delete own" on public.suppliers for delete using (auth.uid() = user_id);

create index if not exists suppliers_user_idx on public.suppliers(user_id, name);

-- ON DELETE SET NULL, not CASCADE: deleting a vendor must never delete the parts
-- you buy from them. The part survives and falls back to its legacy text name.
alter table public.parts
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create index if not exists parts_supplier_idx on public.parts(supplier_id) where supplier_id is not null;

comment on column public.parts.supplier_id is
  'Vendor entity. Nullable. The legacy parts.supplier text is kept as a fallback and is NOT backfilled — resolve display via lib/suppliers.supplierLabel.';
