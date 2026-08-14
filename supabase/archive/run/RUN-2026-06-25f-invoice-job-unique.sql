-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25f — Audit fix #1: prevent duplicate-invoice double-charge
-- ════════════════════════════════════════════════════════════
-- A double-complete of ONE recurring visit (e.g. a mobile double-tap of "Done")
-- could insert TWO invoices for the same job_id, each firing its own AutoPay charge
-- → the customer's card charged twice. This partial unique index makes the second
-- insert fail atomically (23505), which createDraftInvoiceForCompletedJob now treats
-- as a benign "already invoiced" (no error, and AutoPay is never reached on a failed
-- insert). Verified: ZERO existing duplicate job_id invoices in production, so this
-- applies cleanly. Idempotent + additive.
create unique index if not exists invoices_job_id_key
  on public.invoices(job_id) where job_id is not null;
