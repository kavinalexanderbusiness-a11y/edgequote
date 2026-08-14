-- ══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-16 — Balance sheet foundation
--   A/P split · opening balances · fixed assets · liabilities
--
-- ✅ APPLIED + VERIFIED IN PROD 2026-07-16 via MCP (migration `balance_sheet_foundation`).
-- Verified after apply: bill_date NOT NULL · spent_at NULLABLE · 3/3 opening columns ·
-- RLS on both new tables · 8/8 policies · 11 CHECK constraints · 2/2 triggers.
-- Constraints PROBED live (rolled back): straight_line-without-life REFUSED,
-- salvage-above-cost REFUSED, negative-liability REFUSED, valid asset INSERTS.
--
-- WHY THIS EXISTS
-- A balance sheet is only worth printing if `Assets = Liabilities + Equity` is a
-- CHECK rather than a definition. Phase 1 could not support one: cash on hand,
-- money owed to suppliers, what the equipment is worth, and what's owed on loans
-- were all simply absent. Deriving a balance sheet from what existed would have
-- meant plugging equity to force the identity — a tautology wearing a statement's
-- clothes. This adds the four missing inputs so the identity can actually be
-- tested, and so the gap (if any) can be SHOWN instead of hidden.
--
-- Safe to re-run. Additive only: nothing is dropped, no column changes meaning.
--
-- ⚠️ TIMING: written while expenses/vendors/expense_categories/parts/equipment are
-- all EMPTY (verified 0 rows, 2026-07-16). The A/P split below re-points what the
-- cash date MEANS; doing it now costs nothing, and doing it after real receipts
-- exist would silently move money between periods. It is deliberately not deferred.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. A/P: an expense can be INCURRED without being PAID ────────────────────
-- Phase 1 had one date, `spent_at date not null`, meaning "money left". That
-- cannot express "I owe Home Depot $400 and haven't paid it" — the exact row a
-- balance sheet needs for accounts payable.
--
-- The split mirrors `payments.paid_at` (a NULLABLE cash date) on purpose, so both
-- halves of the ledger say "no date = the cash hasn't moved" in the same voice,
-- and the engine's existing undated-money handling carries straight over:
--
--   bill_date  NOT NULL  — when it was INCURRED (the accrual date)
--   spent_at   NULL      — when the CASH LEFT.  NULL ⇒ unpaid ⇒ accounts payable
--
-- Cash-basis P&L keeps filtering on `spent_at`, so an unpaid bill is correctly NOT
-- a cash cost yet; it lands on the balance sheet as a liability instead. This
-- preserves every figure verify:accounting already pins.
alter table public.expenses add column if not exists bill_date date;

-- Backfill BEFORE the not-null: for anything already recorded, incurred = paid.
-- (0 rows today; correct anyway, and required if this ever runs on a live table.)
update public.expenses set bill_date = spent_at where bill_date is null;

alter table public.expenses alter column bill_date set not null;
alter table public.expenses alter column spent_at drop not null;

comment on column public.expenses.bill_date is
  'When the cost was INCURRED (accrual date). Always set.';
comment on column public.expenses.spent_at is
  'When the CASH LEFT. NULL = unpaid = accounts payable. Cash-basis reports filter on this.';

-- Finding the unpaid bills is the A/P query, run on every balance sheet.
create index if not exists expenses_user_unpaid_idx
  on public.expenses(user_id, bill_date)
  where spent_at is null and archived_at is null;
create index if not exists expenses_user_bill_date_idx
  on public.expenses(user_id, bill_date desc)
  where archived_at is null;

-- ── 2. Opening balances ─────────────────────────────────────────────────────
-- Cash on hand is not derivable from a payment ledger alone: the ledger knows
-- every movement since it started, but not what was in the bank the day before.
-- Without an opening balance, "cash" is a movement, not a position — so the owner
-- states it once and every later figure is derived from it.
alter table public.business_settings
  add column if not exists opening_bank_balance numeric(12,2),
  add column if not exists opening_balance_date date,
  -- What the owner had already put into the business at that date. Optional, and
  -- deliberately NOT a plug: leave it null and the balance sheet reports an
  -- unexplained difference rather than silently inventing capital to force a tie.
  add column if not exists opening_equity numeric(12,2);

comment on column public.business_settings.opening_bank_balance is
  'Bank balance as at opening_balance_date. Cash = this + every movement since.';
comment on column public.business_settings.opening_balance_date is
  'The date opening_bank_balance was true. Cash movements before it are ignored.';
comment on column public.business_settings.opening_equity is
  'Owner capital already in the business at the opening date. NULL = unknown (never plugged).';

-- ── 3. Fixed assets ─────────────────────────────────────────────────────────
-- A mower is not an expense the day you buy it — it's an asset that wears out over
-- years. Expensing it entirely in month one understates that month's profit and
-- overstates every month after, and leaves the balance sheet claiming the business
-- owns nothing. Cost + method + life is the minimum to say otherwise.
create table if not exists public.fixed_assets (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null,
  -- Optional link: the asset register and the equipment list are the same physical
  -- thing seen from two sides (what it's worth vs. when it was serviced).
  -- ON DELETE SET NULL — retiring a mower must never delete its cost basis.
  equipment_id      uuid references public.equipment(id) on delete set null,
  vendor_id         uuid references public.vendors(id) on delete set null,
  -- What it cost, GROSS — the same convention as expenses.amount. A non-registrant
  -- cannot reclaim the tax, so the tax is part of what the thing cost.
  cost              numeric(12,2) not null check (cost >= 0),
  tax_amount        numeric(12,2) not null default 0 check (tax_amount >= 0),
  in_service_date   date not null,
  -- 'none' is a first-class answer: land, and anything the owner declines to
  -- depreciate, must not be forced through a schedule to fit the table.
  method            text not null default 'straight_line'
                    check (method in ('straight_line', 'declining_balance', 'none')),
  useful_life_years numeric(4,1) check (useful_life_years > 0),
  salvage_value     numeric(12,2) not null default 0 check (salvage_value >= 0),
  -- Declining balance (CCA in Canada) rate as a percent, e.g. 20 = 20%/yr.
  declining_rate    numeric(5,2) check (declining_rate > 0 and declining_rate <= 100),
  disposed_at       date,
  disposal_proceeds numeric(12,2),
  notes             text,
  archived_at       timestamptz,

  -- Straight-line without a life is not a schedule, it's a wish. The DB refuses it
  -- rather than letting the engine invent a default life and depreciate on a guess.
  constraint fixed_assets_sl_needs_life
    check (method <> 'straight_line' or useful_life_years is not null),
  constraint fixed_assets_db_needs_rate
    check (method <> 'declining_balance' or declining_rate is not null),
  -- You cannot depreciate below what it's worth at the end.
  constraint fixed_assets_salvage_within_cost check (salvage_value <= cost),
  constraint fixed_assets_tax_within_cost check (tax_amount <= cost),
  constraint fixed_assets_disposal_after_service
    check (disposed_at is null or disposed_at >= in_service_date)
);
create index if not exists fixed_assets_user_idx
  on public.fixed_assets(user_id, in_service_date desc) where archived_at is null;
create index if not exists fixed_assets_user_active_idx
  on public.fixed_assets(user_id) where archived_at is null and disposed_at is null;
create index if not exists fixed_assets_equipment_idx
  on public.fixed_assets(equipment_id) where equipment_id is not null;

-- ── 4. Liabilities ──────────────────────────────────────────────────────────
-- Loans and cards. Deliberately an owner-maintained SNAPSHOT, not a derived
-- figure: this app has no bank feed, so a computed balance would be fiction that
-- looks like arithmetic. `as_of_date` is not null so the balance sheet can say how
-- stale it is — an honest old number beats a confident wrong one.
create table if not exists public.liabilities (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  kind            text not null default 'loan'
                  check (kind in ('loan', 'credit_card', 'line_of_credit', 'other')),
  current_balance numeric(12,2) not null check (current_balance >= 0),
  as_of_date      date not null,
  interest_rate   numeric(5,2) check (interest_rate >= 0),
  notes           text,
  archived_at     timestamptz
);
create index if not exists liabilities_user_idx
  on public.liabilities(user_id, as_of_date desc) where archived_at is null;

-- ── 5. RLS — same owner-scoped shape as every other accounting table ────────
alter table public.fixed_assets enable row level security;
alter table public.liabilities  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fixed_assets', 'liabilities'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': select own') then
      execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', t || ': select own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': insert own') then
      execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', t || ': insert own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': update own') then
      execute format('create policy %I on public.%I for update using (auth.uid() = user_id)', t || ': update own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': delete own') then
      execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', t || ': delete own', t);
    end if;
  end loop;
end $$;

-- ── 6. updated_at triggers ──────────────────────────────────────────────────
drop trigger if exists trg_fixed_assets_updated on public.fixed_assets;
create trigger trg_fixed_assets_updated before update on public.fixed_assets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_liabilities_updated on public.liabilities;
create trigger trg_liabilities_updated before update on public.liabilities
  for each row execute function public.set_updated_at();

-- ── 7. Capital purchases are not operating costs ────────────────────────────
-- ✅ APPLIED + VERIFIED IN PROD 2026-07-16 (migration `capital_purchase_flag`).
--
-- Buying a $5,000 mower is not a $5,000 cost — it's $5,000 of cash turning into
-- $5,000 of asset. The cash-basis P&L would expense it, dropping equity by 5,000,
-- while the balance sheet capitalises it, leaving assets net unchanged. The
-- identity then fails by exactly the purchase price, every time, for the single
-- most common thing a trades business buys.
--
-- The flag is on `expenses` (not a join to fixed_assets) so profitAndLoss() stays a
-- pure function of expense rows and never has to be handed an asset register to
-- get its own top line right.
alter table public.expenses
  add column if not exists is_capital boolean not null default false;

comment on column public.expenses.is_capital is
  'This cash bought an ASSET, not an operating cost. Excluded from P&L cost; still real cash out in cash flow; the asset itself lives in fixed_assets.';

alter table public.fixed_assets
  add column if not exists expense_id uuid references public.expenses(id) on delete set null;

comment on column public.fixed_assets.expense_id is
  'The expense row this asset was bought with, when there is one. Traceability only — the P&L uses expenses.is_capital, not this link.';

create index if not exists fixed_assets_expense_idx
  on public.fixed_assets(expense_id) where expense_id is not null;
create index if not exists expenses_user_capital_idx
  on public.expenses(user_id) where is_capital and archived_at is null;

-- ── 8. An owner draw is not a cost ──────────────────────────────────────────
-- ✅ APPLIED + VERIFIED IN PROD 2026-07-16 (migration `expense_category_kind`).
--
-- Phase 1 had one axis, `tax_deductible`, and it was quietly carrying two jobs:
--   • "the CRA won't let you claim this" (a parking fine — still a real cost that
--     genuinely reduces profit)
--   • "this isn't a business cost at all" (an owner draw — a distribution of
--     profit, not a cost of earning it)
--
-- Conflating them makes both statements wrong. A $2,000 draw counted as cost turns
-- a profitable month into a fake loss on the P&L, and on the balance sheet it hits
-- equity twice: once through depressed retained earnings, once as a distribution.
alter table public.expense_categories
  add column if not exists kind text not null default 'operating'
  check (kind in ('operating', 'owner_draw'));

comment on column public.expense_categories.kind is
  'operating = a real business cost (P&L). owner_draw = a distribution of profit, NOT a cost: excluded from the P&L, still cash out in cash flow, and a reduction of equity on the balance sheet.';

create index if not exists expense_categories_user_kind_idx
  on public.expense_categories(user_id, kind) where archived_at is null;
