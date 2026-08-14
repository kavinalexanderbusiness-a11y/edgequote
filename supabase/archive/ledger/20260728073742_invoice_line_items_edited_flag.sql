-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260728073742
--   name    : invoice_line_items_edited_flag
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoices add column if not exists line_items_edited boolean not null default false;
comment on column public.invoices.line_items_edited is 'True once the owner hand-edits this draft''s line items in the invoice editor. syncDraftInvoiceAmounts then skips the draft so a later job-price change never silently overwrites owner-authored line_items/amount (the change-order-loss bug). Defaults false: job-derived drafts keep auto-re-pricing.';