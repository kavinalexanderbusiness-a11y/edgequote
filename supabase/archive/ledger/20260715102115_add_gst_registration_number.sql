-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715102115
--   name    : add_gst_registration_number
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- GST/HST registration number.
--
-- Why this is required, not cosmetic: CRA's Input Tax Credit Information
-- (GST/HST) Regulations require the supplier's registration number on any
-- invoice of $30 or more for the CUSTOMER to claim an input tax credit. The app
-- charges GST (business_settings.gst_percent) but every invoice, receipt and
-- summary it prints carries no registration number — so a commercial customer's
-- ITC is unsupportable, and on audit it is denied and they come back to the
-- operator for a corrected invoice.
--
-- Nullable on purpose: a small supplier under the $30k threshold is not
-- registered, has no number, and must not be forced to invent one. The PDFs
-- print the line only when both gst_percent > 0 and gst_number is set.
--
-- Free text, not a CHECK constraint: the format is 9 digits + RT + 4 (e.g.
-- 123456789RT0001), but operators paste it with spaces and dashes, and a
-- rejected save on a tax field teaches them to leave it blank — which is the
-- exact failure this column exists to prevent.
alter table public.business_settings
  add column if not exists gst_number text;

comment on column public.business_settings.gst_number is
  'GST/HST registration number (e.g. 123456789RT0001). Printed on invoices/receipts when gst_percent > 0 — CRA requires it for the customer to claim an ITC on $30+. Null = not registered.';