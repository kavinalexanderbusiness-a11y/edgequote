-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260728073742
--   name    : invoice_line_items_edited_flag
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

alter table public.invoices add column if not exists line_items_edited boolean not null default false;
comment on column public.invoices.line_items_edited is 'True once the owner hand-edits this draft''s line items in the invoice editor. syncDraftInvoiceAmounts then skips the draft so a later job-price change never silently overwrites owner-authored line_items/amount (the change-order-loss bug). Defaults false: job-derived drafts keep auto-re-pricing.';