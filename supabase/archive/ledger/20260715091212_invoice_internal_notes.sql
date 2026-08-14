-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715091212
--   name    : invoice_internal_notes
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoices
  add column if not exists internal_notes text;

comment on column public.invoices.internal_notes is
  'Private to the owner: never rendered on any PDF or shown in the portal. Home for system provenance (auto-draft origin) and the AutoPay hold flag, so customer-facing `notes` stays the customer''s and editing it cannot break hold detection.';