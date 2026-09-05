-- ══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-26 — recompute invoice status when the invoice's own total
-- changes (production bug under the payments freeze).
--
-- THE BUG
-- recompute_invoice_paid derives invoices.amount_paid / status / paid_at from the
-- payments ledger, but its only trigger sits on the PAYMENTS table. Editing the
-- invoice itself changes the other half of the equation — the total — and nothing
-- refires the engine. Reproduced live: $100 invoice, $75 payment → 'partial'
-- (correct); then the editor applies a $25 discount (amount becomes the $75 net) →
-- balance is $0 everywhere the app computes it, but status stays 'partial' and
-- paid_at is never stamped. The invoice reads "Partially Paid" forever.
--
-- THE FIX — same engine, one more ignition
-- The status rule does NOT change. The recompute body moves verbatim into a core
-- function recompute_invoice_paid_for(invoice_id); the payments trigger delegates
-- to it, and a NEW trigger on invoices delegates to it whenever a money-defining
-- column (amount, discount_type, discount_value) actually changes. One engine,
-- two ignitions — the payments trigger and the invoice-edit trigger cannot drift.
--
-- WHY AFTER + a nested UPDATE (not a BEFORE trigger mutating NEW): the nested
-- UPDATE lists `status` in its SET clause, which is what fires the existing
-- AFTER UPDATE OF status triggers (owner notification, quote sync, integration
-- capture) — the exact path every payment-driven status flip takes today. A
-- BEFORE trigger would change status without those firing. No recursion: the
-- nested UPDATE sets only amount_paid / paid_at / status, none of which are in
-- the new trigger's column list.
--
-- SAFETY: re-runnable (create or replace + drop trigger if exists). No data
-- backfill here — any invoice already stranded in this state is healed the next
-- time its amount or payments change; a one-off recompute over stranded rows is
-- below, guarded to the exact symptom (settled balance, still partial).
-- ══════════════════════════════════════════════════════════════════════════════

-- The ONE recompute engine, extracted verbatim from recompute_invoice_paid.
create or replace function public.recompute_invoice_paid_for(p_invoice_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_inv record;
  v_paid numeric;
  v_total numeric;
  v_gst numeric;
begin
  if p_invoice_id is null then return; end if;

  select i.*, bs.gst_percent into v_inv
  from public.invoices i
  left join public.business_settings bs on bs.user_id = i.user_id
  where i.id = p_invoice_id;
  if not found then return; end if;

  select coalesce(sum(p.amount), 0) into v_paid
  from public.payments p
  where p.invoice_id = p_invoice_id and p.kind = 'payment' and p.status = 'paid';

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
  where id = p_invoice_id;
end; $$;

-- Not a trigger function → directly callable, and it writes invoices as definer.
-- Same closed-REST-surface rule as every trigger function (RUN-2026-07-15).
revoke execute on function public.recompute_invoice_paid_for(uuid) from public, anon, authenticated;

-- Payments trigger: unchanged behaviour, now a thin delegate.
create or replace function public.recompute_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_invoice_paid_for(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end; $$;

-- NEW ignition: the invoice's own money-defining columns changed.
create or replace function public.recompute_invoice_paid_on_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_invoice_paid_for(new.id);
  return null;
end; $$;

revoke execute on function public.recompute_invoice_paid_on_edit() from public, anon, authenticated;

drop trigger if exists trg_recompute_invoice_on_edit on public.invoices;
create trigger trg_recompute_invoice_on_edit
  after update of amount, discount_type, discount_value on public.invoices
  for each row
  when (old.amount is distinct from new.amount
     or old.discount_type is distinct from new.discount_type
     or old.discount_value is distinct from new.discount_value)
  execute function public.recompute_invoice_paid_on_edit();

-- Heal rows already stranded by the bug: settled balance but still 'partial'.
-- Scoped to the exact symptom; the recompute derives everything else itself.
do $$
declare r record;
begin
  for r in
    select i.id
    from public.invoices i
    left join public.business_settings bs on bs.user_id = i.user_id
    where i.status = 'partial'
      and i.amount_paid + 0.01 >= round(i.amount * (1 + coalesce(bs.gst_percent, 0) / 100), 2)
  loop
    perform public.recompute_invoice_paid_for(r.id);
  end loop;
end $$;
