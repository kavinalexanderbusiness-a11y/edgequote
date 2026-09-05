-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809082642
--   name    : portal_hide_draft_invoices
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

do $patch$
declare
  src  text;
  out_ text;
  hits int;
  anchor constant text := 'from public.invoices where customer_id = v_customer)';
  fixed  constant text := 'from public.invoices where customer_id = v_customer and status <> ''draft'')';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data';

  if src is null then
    raise exception 'get_portal_data not found — refusing to guess';
  end if;

  if position(fixed in src) > 0 then
    raise notice 'get_portal_data already filters draft invoices — no change';
    return;
  end if;

  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'expected exactly 1 invoice FROM-clause, found % — refusing to patch blind', hits;
  end if;

  out_ := replace(src, anchor, fixed);
  execute out_;
  raise notice 'get_portal_data patched: invoices now exclude draft';
end
$patch$;

do $verify$
declare
  leaked int;
begin
  select count(*) into leaked
    from public.customer_portal_tokens t
    cross join lateral (select public.get_portal_data(t.token)::jsonb as d) x
    cross join lateral jsonb_array_elements(x.d -> 'invoices') e
   where not t.revoked and e ->> 'status' = 'draft';
  if leaked > 0 then
    raise exception 'still leaking % draft invoice row(s) across live portal tokens', leaked;
  end if;
  raise notice 'verified: 0 draft invoices reachable through any live portal token';
end
$verify$;