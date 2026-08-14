-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715083100
--   name    : revoke_trigger_fn_execute
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Extend the existing REVOKE pattern (RUN-db-catchup-2026-06-25.sql) to the six
-- SECURITY DEFINER trigger functions added since. Triggers do not consult the caller's
-- EXECUTE privilege, and no app code calls these via .rpc() — so this removes REST
-- surface without changing any behaviour.
do $$
declare fn text;
begin
  foreach fn in array array[
    'crm_stamp_review_requested()',
    'crm_sync_referral()',
    'crm_touch_last_contacted()',
    'recompute_equipment_service()',
    'recompute_invoice_paid()',
    'recompute_part_stock()'
  ] loop
    if exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where p.proname = split_part(fn, '(', 1)
        and pg_get_function_identity_arguments(p.oid) = ''
    ) then
      execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    end if;
  end loop;
end $$;