-- ── Deposit / upfront payment request ────────────────────────────────────────
-- Owner-requested: a service business needs to ask for part of the money up
-- front ("50% before we start"), then bill the rest.
--
-- A deposit is NOT modelled as a second invoice and NOT as a new kind of money
-- row. It is a PARTIAL PAYMENT against the invoice that already exists — which
-- already works end to end: `payments` rows carry the amount actually paid, the
-- recompute_invoice_paid trigger derives invoices.amount_paid + 'partial'
-- status, and the Stripe webhook records amount_total (what was CHARGED, not the
-- invoice total). Two production invoices are already sitting in 'partial'.
--
-- So the only thing missing was the REQUEST, and it belongs on the invoice it is
-- a request for — that is what keeps a deposit welded to the right
-- customer/job/invoice instead of becoming a disconnected money record.
--
-- deposit_amount        the exact GST-INCLUSIVE amount asked for up front.
--                       GST-inclusive because that is the number the customer is
--                       told and the number every charge path already works in
--                       (invoiceBalance().total, amount_paid, the Stripe cents) —
--                       storing a net figure here would introduce a second money
--                       convention on the frozen payments path.
--                       The AMOUNT is stored, never the percentage: the amount is
--                       what was communicated, and a stored percent would silently
--                       re-price the request whenever the invoice total changed.
--                       The percentage is derived for display (lib/payments/deposit).
-- deposit_requested_at  when the request was SUCCESSFULLY sent to the customer.
--                       NULL = asked for but not yet sent. Stamped only on a
--                       confirmed send, so the UI can never claim "sent" for a
--                       delivery that failed.
--
-- Both nullable and additive: every existing invoice reads deposit_amount NULL =
-- no deposit requested, which is exactly today's behaviour. Nothing is backfilled.

alter table public.invoices
  add column if not exists deposit_amount numeric,
  add column if not exists deposit_requested_at timestamptz;

-- A deposit of $0 or less is not a request — it is a message asking for nothing.
-- Enforced in the DB rather than only in the app, per the project's standing rule
-- that a constraint beats a check every caller has to remember.
-- (The "not more than the invoice total" rule cannot live here: the total depends
-- on the GST rate in business_settings and the invoice's discount, so it is
-- enforced by validateDeposit() in lib/payments/deposit.ts, which owns that maths
-- for every surface.)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_deposit_amount_positive'
  ) then
    alter table public.invoices
      add constraint invoices_deposit_amount_positive
      check (deposit_amount is null or deposit_amount > 0);
  end if;
end $$;

-- The owner's "who still owes me a deposit" read. Partial index: only invoices
-- that actually carry a request, which is a small minority of the table.
create index if not exists idx_invoices_deposit_outstanding
  on public.invoices (user_id, deposit_requested_at)
  where deposit_amount is not null;

comment on column public.invoices.deposit_amount is
  'GST-inclusive amount requested up front. A deposit is a PARTIAL PAYMENT of this invoice, not a separate invoice. Percentage is derived, never stored — see lib/payments/deposit.ts.';
comment on column public.invoices.deposit_requested_at is
  'When the deposit request was successfully SENT to the customer. NULL = requested but not sent.';
