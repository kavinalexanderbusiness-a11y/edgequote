-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053325
--   name    : change_orders_v1_portal_door
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.portal_respond_change_order(
  p_token text, p_change_order_id uuid, p_decision text, p_reason text default null
) returns json language plpgsql security definer set search_path to 'public' as $function$
declare v_customer uuid; v_status text; v_number text; v_amount numeric;
begin
  if p_decision not in ('approve', 'decline') then
    return json_build_object('ok', false, 'reason', 'bad_decision');
  end if;
  select customer_id into v_customer
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then
    return json_build_object('ok', false, 'reason', 'no_access');
  end if;

  update public.change_orders
     set status      = case when p_decision = 'approve' then 'approved' else 'declined' end,
         decided_via = 'portal',
         decline_reason = case when p_decision = 'decline' then nullif(btrim(coalesce(p_reason, '')), '') else null end
   where id = p_change_order_id
     and customer_id = v_customer
     and status = 'pending'
  returning status, co_number, amount into v_status, v_number, v_amount;

  if v_status is null then
    return json_build_object('ok', false, 'reason', 'not_pending');
  end if;
  return json_build_object('ok', true, 'status', v_status, 'number', v_number, 'amount', v_amount);
end $function$;

revoke all on function public.portal_respond_change_order(text, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.portal_respond_change_order(text, uuid, text, text) to anon, authenticated;