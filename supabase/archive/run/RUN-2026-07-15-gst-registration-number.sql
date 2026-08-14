-- GST/HST registration number on business_settings.
--
-- STATUS: APPLIED to production 2026-07-15 via Supabase MCP and verified live
-- (information_schema shows gst_number text, nullable, comment present).
-- Committed so the repo can rebuild what production actually is.
--
-- WHY THIS IS REQUIRED, NOT COSMETIC
-- CRA's Input Tax Credit Information (GST/HST) Regulations require the
-- supplier's registration number on any invoice of $30 or more for the CUSTOMER
-- to claim an input tax credit. EdgeQuote charges GST (business_settings.
-- gst_percent) but every invoice, receipt and summary it printed carried no
-- registration number. A commercial customer's ITC is therefore unsupportable:
-- on audit it is denied and they come back to the operator for a corrected
-- invoice. Residential customers never notice, which is why this can sit
-- undetected for years — it bites exactly the customers worth having (property
-- managers, condo boards, commercial lots).
--
-- NULLABLE ON PURPOSE
-- A small supplier under the $30k threshold is not registered, has no number,
-- and must not be forced to invent one. The PDFs print the line only when BOTH
-- gst_percent > 0 AND gst_number is set — a non-registrant prints nothing and
-- never holds itself out as registered.
--
-- FREE TEXT, NOT A CHECK CONSTRAINT
-- The format is 9 digits + RT + 4 (e.g. 123456789RT0001), but operators paste it
-- with spaces and dashes. A rejected save on a tax field teaches them to leave it
-- blank — the exact failure this column exists to prevent.
--
-- Idempotent: safe to re-run.

alter table public.business_settings
  add column if not exists gst_number text;

comment on column public.business_settings.gst_number is
  'GST/HST registration number (e.g. 123456789RT0001). Printed on invoices/receipts when gst_percent > 0 — CRA requires it for the customer to claim an ITC on $30+. Null = not registered.';
