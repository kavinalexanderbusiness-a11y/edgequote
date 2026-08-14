-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809081058
--   name    : invoice_deposit_request
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoices
  add column if not exists deposit_amount numeric,
  add column if not exists deposit_requested_at timestamptz;

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

create index if not exists idx_invoices_deposit_outstanding
  on public.invoices (user_id, deposit_requested_at)
  where deposit_amount is not null;

comment on column public.invoices.deposit_amount is
  'GST-inclusive amount requested up front. A deposit is a PARTIAL PAYMENT of this invoice, not a separate invoice. Percentage is derived, never stored — see lib/payments/deposit.ts.';
comment on column public.invoices.deposit_requested_at is
  'When the deposit request was successfully SENT to the customer. NULL = requested but not sent.';