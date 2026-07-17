-- ══════════════════════════════════════════════════════════════════════════════
-- Accounting foundation — money OUT. Expenses, vendors, expense categories.
--
-- APPLIED + VERIFIED IN PROD 2026-07-15 via MCP. This file is the REPO's record of
-- what ran: there is no migration ledger in this project, so without it the repo
-- silently disagrees with production about what the schema is. (It was applied
-- before this file existed — that gap is the reason this header exists.)
--
-- WHY A SEPARATE TABLE, not the payments ledger:
-- `payments` is the single source of truth for money RECEIVED and is welded to
-- invoices by trg_recompute_invoice_paid, which derives invoices.amount_paid and
-- invoices.status from its rows. An expense has no invoice, so putting it there
-- would be a payment that breaks that trigger's meaning — and would rewrite the
-- engine AutoPay, Stripe webhooks, reconciliation, dunning and receipts already
-- depend on (the frozen invoice/payment lane). payments stays untouched.
-- Reporting reads BOTH and lives in ONE engine (lib/accounting) — never a second
-- accounting model.
--
-- AMOUNT CONVENTION (load-bearing — read before writing any report):
--   amount     = the GROSS total paid, exactly as the receipt / bank line reads.
--   tax_amount = the tax INCLUDED in that total (GST paid → an ITC).
--   net        = amount - tax_amount.
-- Cash flow uses `amount` (it must reconcile to the bank). P&L uses net (recoverable
-- tax is not an expense). Storing gross + tax makes BOTH derivable from ONE row, so
-- the two reports can never disagree. Storing net instead would make cash flow
-- unreconcilable without re-deriving tax.
--
-- Additive + idempotent. Safe to re-run. No existing table is altered.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Vendors ──────────────────────────────────────────────────────────────────
create table if not exists public.vendors (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  contact_name   text,
  phone          text,
  email          text,
  website        text,
  account_number text,          -- the owner's account with this vendor
  notes          text,
  -- Soft delete: a deleted vendor must not vacuum its expense history out of the
  -- P&L. Expenses point here ON DELETE SET NULL as a second belt.
  archived_at    timestamptz
);
-- One vendor per name per owner, case-insensitively — "Home Depot" and
-- "home depot" are the same supplier, and a duplicate silently splits spend
-- across two rows in every report.
create unique index if not exists vendors_user_name_uniq
  on public.vendors(user_id, lower(trim(name))) where archived_at is null;
create index if not exists vendors_user_idx on public.vendors(user_id) where archived_at is null;

-- ── Expense categories ───────────────────────────────────────────────────────
create table if not exists public.expense_categories (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  -- Not every dollar out is deductible (owner draws, personal). P&L must be able
  -- to tell, and this is also the field a QBO/Xero account mapping hangs off later.
  tax_deductible boolean not null default true,
  -- The accounting-software account this category maps to. Free text and nullable
  -- on purpose: it's the seam the export layer fills in WITHOUT the accounting
  -- model needing to know QuickBooks or Xero exists.
  external_account text,
  sort_order     int not null default 0,
  archived_at    timestamptz
);
create unique index if not exists expense_categories_user_name_uniq
  on public.expense_categories(user_id, lower(trim(name))) where archived_at is null;
create index if not exists expense_categories_user_idx
  on public.expense_categories(user_id, sort_order) where archived_at is null;

-- ── Expenses ─────────────────────────────────────────────────────────────────
create table if not exists public.expenses (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- SET NULL, never CASCADE: losing a vendor or category must never delete money
  -- out of the books.
  vendor_id      uuid references public.vendors(id) on delete set null,
  category_id    uuid references public.expense_categories(id) on delete set null,
  -- Optional job link — job costing (what did this visit really cost?) falls out
  -- of the same row, with no second table.
  job_id         uuid references public.jobs(id) on delete set null,
  amount         numeric(10,2) not null check (amount >= 0),      -- GROSS, see header
  tax_amount     numeric(10,2) not null default 0 check (tax_amount >= 0),
  -- Tax can't exceed the total it's included in, or net goes negative and every
  -- report built on it lies. A DB constraint, not an app check.
  constraint expenses_tax_within_amount check (tax_amount <= amount),
  spent_at       date not null,
  description    text,
  payment_method text,          -- card / cash / e-transfer / cheque
  reference      text,          -- receipt or invoice number
  -- Storage path in the EXISTING private bucket — no second upload system.
  receipt_path   text,
  notes          text,
  archived_at    timestamptz
);
-- Every report is "this owner, this date range" — index for exactly that.
create index if not exists expenses_user_date_idx
  on public.expenses(user_id, spent_at desc) where archived_at is null;
create index if not exists expenses_category_idx on public.expenses(category_id) where archived_at is null;
create index if not exists expenses_vendor_idx   on public.expenses(vendor_id)   where archived_at is null;
create index if not exists expenses_job_idx      on public.expenses(job_id)      where archived_at is null;

-- ── RLS: owner-scoped, same shape as every other table here ──────────────────
alter table public.vendors            enable row level security;
alter table public.expense_categories enable row level security;
alter table public.expenses           enable row level security;

do $$
declare t text;
begin
  foreach t in array array['vendors','expense_categories','expenses'] loop
    execute format('drop policy if exists %I on public.%I', t || ': select own', t);
    execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', t || ': select own', t);
    execute format('drop policy if exists %I on public.%I', t || ': insert own', t);
    execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', t || ': insert own', t);
    execute format('drop policy if exists %I on public.%I', t || ': update own', t);
    execute format('create policy %I on public.%I for update using (auth.uid() = user_id)', t || ': update own', t);
    execute format('drop policy if exists %I on public.%I', t || ': delete own', t);
    execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', t || ': delete own', t);
  end loop;
end $$;

-- ── updated_at: reuse the shared trigger fn, don't define a second one ────────
drop trigger if exists trg_vendors_updated on public.vendors;
create trigger trg_vendors_updated before update on public.vendors
  for each row execute function public.set_updated_at();
drop trigger if exists trg_expense_categories_updated on public.expense_categories;
create trigger trg_expense_categories_updated before update on public.expense_categories
  for each row execute function public.set_updated_at();
drop trigger if exists trg_expenses_updated on public.expenses;
create trigger trg_expenses_updated before update on public.expenses
  for each row execute function public.set_updated_at();
