-- ── Internal invoice notes ───────────────────────────────────────────────────
-- invoices.notes was doing three incompatible jobs at once:
--   1. printed on the customer's PDF (InvoicePDF renders a "Notes" box from it),
--   2. written by the system — the auto-draft stamps "Auto-generated from
--      completed weekly visit on <date>." into it,
--   3. read as a CONTROL SIGNAL — autopay.ts and the invoices page decide whether
--      a charge is held for review with notes.includes('AutoPay held').
--
-- So machine text prints on customer documents (22 of 24 live invoices did), an
-- AutoPay hold prints the owner's own pricing baseline at the customer ("$450
-- differs from the usual ~$120"), and — now that invoices are editable after
-- approval — an owner retyping that note silently breaks hold detection, because
-- the flag IS the customer-facing string.
--
-- internal_notes splits them: `notes` stays the customer's, `internal_notes` is
-- the owner's and the system's, and it is never rendered by any PDF.
--
-- Nullable, no backfill: the 22 existing invoices keep the notes their customers
-- already received. Only invoices created from here on route machine text to the
-- private field. Same principle as quotes.valid_until — don't rewrite documents
-- that are already out.
--
-- Idempotent: safe to run more than once.

alter table public.invoices
  add column if not exists internal_notes text;

comment on column public.invoices.internal_notes is
  'Private to the owner: never rendered on any PDF or shown in the portal. Home for system provenance (auto-draft origin) and the AutoPay hold flag, so customer-facing `notes` stays the customer''s and editing it cannot break hold detection.';
