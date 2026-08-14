-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-09 — Backfill ledger rows for LEGACY paid invoices.
-- Invoices marked paid BEFORE the payment ledger existed have status='paid'
-- but no `payments` row and amount_paid = 0. They therefore bypass every
-- ledger-driven surface: no receipt can be rendered, the payment timeline and
-- portal history omit them, the Paid summary hides, and their full total
-- wrongly counts as OUTSTANDING (balance = total − 0).
--
-- Fix: insert ONE synthetic kind='payment' row per such invoice for its
-- GST-inclusive total, dated from its paid_at. The existing
-- recompute_invoice_paid trigger then derives amount_paid/status exactly like
-- any modern payment — one ledger engine, no special cases left in the app.
--
-- Idempotent two ways: the anti-join (only invoices with NO payment rows) and
-- the unique stripe_session_id 'legacy:<invoice id>'. Safe to re-run.
-- ════════════════════════════════════════════════════════════

insert into public.payments
  (user_id, customer_id, invoice_id, amount, currency, provider, kind, method,
   status, paid_at, notes, stripe_session_id)
select
  i.user_id,
  i.customer_id,
  i.id,
  round(i.amount * (1 + coalesce(bs.gst_percent, 0) / 100), 2),   -- what the trigger expects as "total"
  'cad',
  coalesce(i.payment_method, 'other'),
  'payment',
  coalesce(i.payment_method, 'other'),
  'paid',
  coalesce(i.paid_at, i.updated_at, now()),
  'Recorded from legacy mark-paid (backfill)',
  'legacy:' || i.id
from public.invoices i
left join public.business_settings bs on bs.user_id = i.user_id
where i.status = 'paid'
  and not exists (
    select 1 from public.payments p
    where p.invoice_id = i.id and p.kind = 'payment'
  )
on conflict (stripe_session_id) do nothing;
