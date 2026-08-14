-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716234850
--   name    : capital_purchase_flag
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

-- ── Capital purchases are not operating costs ───────────────────────────────
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

-- The optional back-link: which cash purchase this asset came from. ON DELETE SET
-- NULL — deleting a receipt must never delete the asset's cost basis.
alter table public.fixed_assets
  add column if not exists expense_id uuid references public.expenses(id) on delete set null;

comment on column public.fixed_assets.expense_id is
  'The expense row this asset was bought with, when there is one. Traceability only — the P&L uses expenses.is_capital, not this link.';

create index if not exists fixed_assets_expense_idx
  on public.fixed_assets(expense_id) where expense_id is not null;
create index if not exists expenses_user_capital_idx
  on public.expenses(user_id) where is_capital and archived_at is null;