-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716053848
--   name    : suppliers
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

create table if not exists public.suppliers (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  contact_name   text,
  phone          text,
  email          text,
  website        text,
  account_number text,
  address        text,
  notes          text,
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

alter table public.parts
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create index if not exists parts_supplier_idx on public.parts(supplier_id) where supplier_id is not null;

comment on column public.parts.supplier_id is
  'Vendor entity. Nullable. The legacy parts.supplier text is kept as a fallback and is NOT backfilled — resolve display via lib/suppliers.supplierLabel.';