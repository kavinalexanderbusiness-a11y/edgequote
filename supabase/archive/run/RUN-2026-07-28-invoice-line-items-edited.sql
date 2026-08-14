-- RUN-2026-07-28-invoice-line-items-edited.sql
-- APPLIED to prod 2026-07-28 (migration: invoice_line_items_edited_flag).
--
-- Fixes a silent change-order data-loss / under-bill bug.
--
-- The invoice editor invites the owner to add lines to a draft ("+ Add line item"
-- — e.g. "Extra: gutter clear $80"). But syncDraftInvoiceAmounts rebuilds a
-- job-linked draft's line_items + amount from the JOB whenever the job's price is
-- touched (10 call sites). It already preserved a hand-set discount, but NOT
-- hand-edited line_items: the owner's added line silently vanished and the invoice
-- total dropped by that amount — a quiet under-bill the owner never saw.
--
-- This column marks a draft whose breakdown the owner has hand-edited. The sync
-- then leaves that draft alone (lib/invoicing.ts: `if (inv.line_items_edited)
-- continue`), so a later job-price change never overwrites owner-authored
-- lines/amount. The invoice editor sets it (only, never clears) the moment the
-- persisted breakdown diverges from what loaded. Defaults false, so every existing
-- draft and every future job-derived draft keeps auto-re-pricing exactly as before.
--
-- Additive + idempotent + non-destructive.

alter table public.invoices
  add column if not exists line_items_edited boolean not null default false;

comment on column public.invoices.line_items_edited is
  'True once the owner hand-edits this draft''s line items in the invoice editor. syncDraftInvoiceAmounts then skips the draft so a later job-price change never silently overwrites owner-authored line_items/amount (the change-order-loss bug). Defaults false: job-derived drafts keep auto-re-pricing.';
