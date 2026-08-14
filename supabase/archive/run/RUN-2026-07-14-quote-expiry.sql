-- ── Quote expiry ─────────────────────────────────────────────────────────────
-- Quotes had no expiry at all: a price sent in April stayed acceptable in
-- October, at April's price. This adds the one missing field.
--
-- valid_until is a DATE (not a timestamp) because expiry is a calendar promise
-- the customer reads off the PDF — "valid until Aug 12" — not an instant. It's
-- nullable: quotes sent before this existed simply never expire, rather than all
-- becoming retroactively expired the moment this runs.
--
-- Nothing about the stored lifecycle changes: 'expired' is a DISPLAY overlay
-- derived by lib/quoteStatus (exactly how invoices derive 'overdue' from the
-- ledger), so there is no new status to keep in sync and no backfill.
--
-- Idempotent: safe to run more than once.

alter table public.quotes
  add column if not exists valid_until date;

comment on column public.quotes.valid_until is
  'Calendar date this quote stops being valid. Null = never expires (incl. every quote sent before expiry existed). ''expired'' is derived for display by lib/quoteStatus — it is never stored in quotes.status.';
