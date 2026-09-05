-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260727033122
--   name    : invoice_status_on_total_edit
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Recompute invoice status when the invoice's own total changes.
-- The status rule is UNCHANGED — the recompute body moves verbatim into a core
-- function; the payments trigger delegates to it, and a new trigger on invoices
-- delegates to it when a money-defining column actually changes.

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

revoke execute on function public.recompute_invoice_paid_for(uuid) from public, anon, authenticated;

create or replace function public.recompute_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_invoice_paid_for(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end; $$;

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