-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811061219
--   name    : get_portal_data_quote_options
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Adds ONE thing to get_portal_data: each quote's alternatives, plus which one
-- the customer selected. Everything else is untouched by construction — the new
-- definition is DERIVED from the live one via pg_get_functiondef rather than
-- retyped, because retyping this function is exactly how a `create or replace`
-- chain has previously rolled it back to an older body. If the anchor is not
-- found, or is found more than once, this raises and changes nothing.
do $do$
declare
  v_def text;
  v_anchor text := '             qt.issued_date, qt.crew_size, qt.hours, qt.travel_fee, qt.valid_until,';
  v_add text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data';
  if v_def is null then raise exception 'get_portal_data not found'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception 'anchor matched % times, expected exactly 1 — refusing to rewrite get_portal_data', v_hits;
  end if;

  v_add := v_anchor || E'\n'
    || E'             qt.selected_option_id,\n'
    -- The alternatives this quote offered, in the owner''s order. Empty for every
    -- existing quote, which is what keeps the portal''s behaviour identical for them.
    || E'             coalesce((select json_agg(o order by o.sort_order) from (\n'
    || E'               select qo.id, qo.name, qo.description, qo.price, qo.sort_order, qo.is_recommended\n'
    || E'               from public.quote_options qo where qo.quote_id = qt.id\n'
    || E'             ) o), ''[]''::json) as options,';

  v_def := replace(v_def, v_anchor, v_add);
  execute v_def;
end $do$;