-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION 
—
 HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260816093000
--   name    : portal_change_order_tenant_scope
--
-- Applied to production 2026-08-16 via the management API (Session 75) and
-- recorded in the ledger. Folded into the baseline by npm run schema:baseline.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ── portal_respond_change_order: the one the first pass missed ──────────────
-- The patcher inspected a 320-character window per clause; this UPDATE reaches
--  at roughly 330, so it read as having no customer
-- reference at all and was reported "already scoped". A second, wider analyser
-- run against production AFTER the apply is what caught it — which is the whole
-- reason that re-audit exists rather than trusting the patch report.
-- Body read from production with pg_get_functiondef, edited in place.

CREATE OR REPLACE FUNCTION public.portal_respond_change_order(p_token text, p_change_order_id uuid, p_decision text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_status text; v_number text; v_amount numeric;
begin
  if p_decision not in ('approve', 'decline') then
    return json_build_object('ok', false, 'reason', 'bad_decision');
  end if;
  select customer_id, user_id into v_customer, v_user
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
     and user_id = v_user
     and status = 'pending'
  returning status, co_number, amount into v_status, v_number, v_amount;

  if v_status is null then
    return json_build_object('ok', false, 'reason', 'not_pending');
  end if;
  return json_build_object('ok', true, 'status', v_status, 'number', v_number, 'amount', v_amount);
end $function$;
