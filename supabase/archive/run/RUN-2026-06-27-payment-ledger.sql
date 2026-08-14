-- ════════════════════════════════════════════════════════════════════════════
-- Payment ledger + customer credit (extends the EXISTING payments/invoices tables).
-- Self-contained + idempotent: safe to run even though the column/trigger layer is
-- already deployed. Also folds in the invoice-discount columns so this one file
-- satisfies the portal RPC's column dependencies regardless of run order.
--   • payments: kind / method / notes  (+ owner insert/update/delete RLS)
--   • invoices: amount_paid (trigger-maintained) + expanded status vocabulary
--   • recompute_invoice_paid() trigger: derives amount_paid + status from the ledger
--   • get_portal_data / portal_invoice_for_payment: expose amount_paid (+ discount,
--     payment kind) and let partly-paid invoices be paid online.
-- invoices.amount stays the NET (post-discount) subtotal; payments are GST-inclusive,
-- so balance = invoiceTotals(amount).total − amount_paid everywhere.
-- ════════════════════════════════════════════════════════════════════════════

-- ── payments: ledger columns + owner write access ────────────────────────────
alter table public.payments
  add column if not exists kind   text not null default 'payment',
  add column if not exists method text,
  add column if not exists notes  text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_kind_check') then
    alter table public.payments add constraint payments_kind_check check (kind in ('payment','credit'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payments' and policyname='payments: insert own') then
    create policy "payments: insert own" on public.payments for insert with check (auth.uid() = user_id);
    create policy "payments: update own" on public.payments for update using (auth.uid() = user_id);
    create policy "payments: delete own" on public.payments for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists payments_customer_kind_idx on public.payments(customer_id, kind);

-- ── invoices: discount columns + amount_paid + status vocabulary ─────────────
alter table public.invoices
  add column if not exists discount_type  text,
  add column if not exists discount_value numeric(10,2),
  add column if not exists amount_paid    numeric(10,2) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_discount_type_check') then
    alter table public.invoices add constraint invoices_discount_type_check check (discount_type is null or discount_type in ('amount','percent'));
  end if;
end $$;
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft','unpaid','sent','partial','paid','overpaid'));

-- ── Recompute amount_paid + status from the ledger (GST-aware) ───────────────
create or replace function public.recompute_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_inv uuid; v_paid numeric; v_amount numeric; v_gst numeric; v_total numeric; v_user uuid; v_status text;
begin
  v_inv := coalesce(new.invoice_id, old.invoice_id);
  if v_inv is null then return coalesce(new, old); end if;
  select amount, user_id, status into v_amount, v_user, v_status from public.invoices where id = v_inv;
  if not found then return coalesce(new, old); end if;
  select coalesce(sum(amount),0) into v_paid from public.payments where invoice_id = v_inv and kind='payment' and status='paid';
  select coalesce(gst_percent,0) into v_gst from public.business_settings where user_id = v_user;
  v_total := round(coalesce(v_amount,0) * (1 + coalesce(v_gst,0)/100), 2);
  update public.invoices set
    amount_paid = round(v_paid,2),
    paid_at = case when v_paid >= v_total and v_total > 0 then coalesce(paid_at, now())
                   when v_paid <= 0 then null else paid_at end,
    status = case
      when status='draft' then 'draft'
      when v_paid <= 0 then (case when status in ('paid','partial','overpaid') then 'unpaid' else status end)
      when v_paid + 0.01 < v_total then 'partial'
      when v_paid <= v_total + 0.01 then 'paid'
      else 'overpaid' end
  where id = v_inv;
  return coalesce(new, old);
end; $$;
drop trigger if exists trg_recompute_invoice_paid on public.payments;
create trigger trg_recompute_invoice_paid after insert or update or delete on public.payments
  for each row execute function public.recompute_invoice_paid();

-- ── get_portal_data: invoices += amount_paid + discount; payments += kind ─────
-- Faithful copy of the deployed function with those fields added.
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️  SUPERSEDED — DO NOT RESTORE THIS BODY.  (INF-2, 2026-07-17)
--
--   get_portal_data now has exactly ONE definition:
--       supabase/CANONICAL-get_portal_data.sql
--
--   A complete, runnable OLDER copy stood here. Running this file replaced the
--   live function with it — silently, with no error — dropping
--   the `services` and `properties` keys.
--   Nothing failed; the portal just started returning less. That is why the
--   body is gone rather than merely commented "outdated".
--
--   Everything else in this file is UNCHANGED and still safe to run.
-- ══════════════════════════════════════════════════════════════════════════
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- ── portal_invoice_for_payment: return amount_paid + allow partial invoices ──
create or replace function public.portal_invoice_for_payment(p_token text, p_invoice_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; result json;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(i) into result from (
    select id, invoice_number, service_type, amount, amount_paid, status, customer_id, user_id
    from public.invoices where id = p_invoice_id and customer_id = v_customer and status in ('unpaid','sent','partial')
  ) i;
  return result;
end; $$;
grant execute on function public.portal_invoice_for_payment(text, uuid) to anon, authenticated;
