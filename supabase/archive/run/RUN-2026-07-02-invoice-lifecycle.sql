-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-02 — Invoice lifecycle: Viewed + Cancelled.
-- Completes the QuickBooks-style flow: Draft → Sent → Viewed → Partial → Paid,
-- with Overdue derived at read time (ledger.ts) and Cancelled as a terminal
-- stored status. Idempotent; safe to re-run.
--   • viewed_at — stamped (once) when the CUSTOMER opens the invoice in the
--     portal, via a token-scoped RPC (same pattern as portal_mark_reviewed).
--     'Viewed' is a display overlay of 'sent', never a stored status.
--   • 'cancelled' — added to the status check. The payments-ledger trigger is
--     guarded so recording/removing payments never resurrects a cancelled
--     invoice; the app only allows cancelling when nothing has been paid.
-- ════════════════════════════════════════════════════════════

alter table public.invoices add column if not exists viewed_at timestamptz;

-- Status check now includes 'cancelled' (supersedes the 2026-06-27 ledger check).
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft','unpaid','sent','partial','paid','overpaid','cancelled'));

-- Ledger trigger: leave cancelled invoices alone (a refund on a cancelled
-- invoice must not flip it back to 'unpaid').
create or replace function public.recompute_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_invoice_id uuid;
  v_inv record;
  v_paid numeric;
  v_total numeric;
  v_gst numeric;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  if v_invoice_id is null then return coalesce(new, old); end if;

  select i.*, bs.gst_percent into v_inv
  from public.invoices i
  left join public.business_settings bs on bs.user_id = i.user_id
  where i.id = v_invoice_id;
  if not found then return coalesce(new, old); end if;

  select coalesce(sum(p.amount), 0) into v_paid
  from public.payments p
  where p.invoice_id = v_invoice_id and p.kind = 'payment' and p.status = 'paid';

  v_gst := coalesce(v_inv.gst_percent, 0);
  v_total := round(v_inv.amount * (1 + v_gst / 100), 2);

  update public.invoices set
    amount_paid = v_paid,
    paid_at = case when v_paid + 0.01 >= v_total and v_total > 0 then coalesce(paid_at, now()) else null end,
    status = case
      when status = 'cancelled' then status                    -- terminal: never auto-revived
      when status = 'draft' then status
      when v_paid <= 0 then (case when status in ('paid','partial','overpaid') then 'unpaid' else status end)
      when v_paid + 0.01 < v_total then 'partial'
      when v_paid <= v_total + 0.01 then 'paid'
      else 'overpaid'
    end
  where id = v_invoice_id;

  return coalesce(new, old);
end; $$;

-- Customer opened this invoice in the portal (idempotent; token-scoped so the
-- anon portal can call it for its own customer's invoices only).
create or replace function public.portal_mark_invoice_viewed(p_token text, p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user
  from public.customer_portal_tokens
  where token = p_token and not revoked;
  if v_customer is null then return; end if;
  update public.invoices
     set viewed_at = coalesce(viewed_at, now())
   where id = p_invoice_id and customer_id = v_customer and user_id = v_user
     and status <> 'draft';
end; $$;
grant execute on function public.portal_mark_invoice_viewed(text, uuid) to anon, authenticated;
