-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814074926
--   name    : quote_addons_v1_portal_projection
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- get_portal_data gains ONE key: `addons`, nested under each quote beside
-- `options` and `services`. Modified by TRANSFORMING pg_get_functiondef output at
-- a guarded single anchor and re-executing it — never by retyping the function,
-- which is how a create-or-replace chain previously rolled this RPC backward.
do $do$
declare v_def text; v_anchor text; v_ins text; v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data';
  if v_def is null then raise exception 'get_portal_data not found'; end if;

  if position('as addons,' in v_def) > 0 then
    raise notice 'addons already projected — nothing to do';
    return;
  end if;

  v_anchor := ') o), ''[]''::json) as options,';
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception 'expected exactly 1 options anchor in get_portal_data, found %', v_hits;
  end if;

  -- ⛔ `selected_via` is deliberately NOT projected. The customer needs to know
  -- WHICH extras are on their quote and what each costs; who clicked last is the
  -- business's record, not theirs.
  v_ins := v_anchor || E'\n             coalesce((select json_agg(a order by a.sort_order) from (\n               select qa.id, qa.name, qa.description, qa.price, qa.sort_order, qa.is_selected\n               from public.quote_addons qa where qa.quote_id = qt.id\n             ) a), ''[]''::json) as addons,';

  execute replace(v_def, v_anchor, v_ins);
end $do$;