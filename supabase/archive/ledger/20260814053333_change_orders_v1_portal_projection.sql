-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053333
--   name    : change_orders_v1_portal_projection
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_def text; v_new text;
  v_anchor text := '    ''payment_method'', (select to_json(pm) from (select brand, last4, exp_month, exp_year from public.payment_methods';
  v_add text := '    ''change_orders'', coalesce((select json_agg(co order by co.created_at desc) from ('
    || 'select id, co_number, job_id, quote_id, description, amount, status, decided_via, created_at, sent_at, approved_at, declined_at '
    || 'from public.change_orders where customer_id = v_customer and status <> ''draft'') co), ''[]''::json),' || chr(10);
begin
  v_def := pg_get_functiondef('public.get_portal_data(text)'::regprocedure);
  if position('change_orders' in v_def) > 0 then
    raise notice 'get_portal_data already projects change_orders - leaving it alone';
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'get_portal_data anchor not found - refusing to guess where the key goes';
  end if;
  v_new := replace(v_def, v_anchor, v_add || v_anchor);
  if v_new = v_def then raise exception 'get_portal_data transform was a no-op'; end if;
  execute v_new;
end $$;