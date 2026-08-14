-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716235052
--   name    : expense_category_kind
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── An owner draw is not a cost ─────────────────────────────────────────────
-- Phase 1 had one axis, `tax_deductible`, and it was quietly carrying two jobs:
--   • "the CRA won't let you claim this" (a parking fine — still a real cost that
--     genuinely reduces profit)
--   • "this isn't a business cost at all" (an owner draw — a distribution of
--     profit, not a cost of earning it)
--
-- Conflating them makes both statements wrong. A $2,000 draw counted as cost turns
-- a profitable month into a fake loss on the P&L, and on the balance sheet it hits
-- equity twice: once through depressed retained earnings, once as a distribution.
--
-- `kind` separates the axes. tax_deductible keeps its real job (can you claim it);
-- kind answers whether it belongs in the P&L at all.
alter table public.expense_categories
  add column if not exists kind text not null default 'operating'
  check (kind in ('operating', 'owner_draw'));

comment on column public.expense_categories.kind is
  'operating = a real business cost (P&L). owner_draw = a distribution of profit, NOT a cost: excluded from the P&L, still cash out in cash flow, and a reduction of equity on the balance sheet.';

-- Existing rows keep the default 'operating' — correct, and safe on an empty table
-- (0 category rows today). Seeding sets kind explicitly for the draw defaults.
create index if not exists expense_categories_user_kind_idx
  on public.expense_categories(user_id, kind) where archived_at is null;