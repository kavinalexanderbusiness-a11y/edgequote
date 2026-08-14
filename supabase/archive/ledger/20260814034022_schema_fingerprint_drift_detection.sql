-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034022
--   name    : schema_fingerprint_drift_detection
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- schema_fingerprint() — the mechanism that makes schema drift VISIBLE
--
-- The problem it solves: production and this repository disagreed for seven weeks
-- and nothing could tell. 30 migrations reached production leaving no repo file;
-- three more landed while the audit that found them was still running. Nobody was
-- careless — there was simply no instrument.
--
-- PostgREST cannot read pg_catalog, so `npm run verify:schema` has no way to ask
-- production what shape it is in. This is that way.
--
-- WHAT IT RETURNS: counts and md5 hashes, per section. No table names, no column
-- names, no data — a caller learns "the policy section changed", never what a
-- policy says. That is deliberately the least information that still answers the
-- question, so granting it to `authenticated` leaks nothing worth having.
--
-- READ-ONLY: no writes, no DDL, no side effects. Marked STABLE.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.schema_fingerprint()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with
  -- extension-owned functions are pg_trgm/pgcrypto internals: they move when the
  -- platform upgrades an extension, which is not OUR drift and must not alarm.
  ext_fns as (
    select d.objid from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.deptype = 'e'
  ),
  tables_s as (
    select string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text, E'\n' order by c.relname) as s,
           count(*) as n
    from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  columns_s as (
    select string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
             || ':' || a.attnotnull::text || ':' || coalesce(a.attgenerated::text, '')
             || ':' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), E'\n'
             order by c.relname, a.attname) as s,
           count(*) as n
    from pg_attribute a
    join pg_class c on a.attrelid = c.oid
    join pg_namespace n on c.relnamespace = n.oid
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  ),
  constraints_s as (
    select string_agg(cl.relname || '.' || con.conname || ':' || pg_get_constraintdef(con.oid), E'\n'
             order by cl.relname, con.conname) as s,
           count(*) as n
    from pg_constraint con
    join pg_class cl on con.conrelid = cl.oid
    join pg_namespace n on cl.relnamespace = n.oid
    where n.nspname = 'public'
  ),
  indexes_s as (
    select string_agg(i.indexname || ':' || i.indexdef, E'\n' order by i.indexname) as s, count(*) as n
    from pg_indexes i where i.schemaname = 'public'
  ),
  functions_s as (
    select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
             || md5(pg_get_functiondef(p.oid)), E'\n'
             order by p.proname, pg_get_function_identity_arguments(p.oid)) as s,
           count(*) as n
    from pg_proc p join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public' and p.prokind = 'f' and p.oid not in (select objid from ext_fns)
  ),
  fn_grants_s as (
    select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
             || coalesce(p.proacl::text, '<default>'), E'\n'
             order by p.proname, pg_get_function_identity_arguments(p.oid)) as s,
           count(*) as n
    from pg_proc p join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public' and p.prokind = 'f' and p.oid not in (select objid from ext_fns)
  ),
  table_grants_s as (
    select string_agg(c.relname || ':' || coalesce(c.relacl::text, '<default>'), E'\n' order by c.relname) as s,
           count(*) as n
    from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  policies_s as (
    select string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd || ':' || p.roles::text
             || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, ''), E'\n'
             order by p.tablename, p.policyname) as s,
           count(*) as n
    from pg_policies p where p.schemaname = 'public'
  ),
  triggers_s as (
    select string_agg(c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid), E'\n'
             order by c.relname, t.tgname) as s,
           count(*) as n
    from pg_trigger t join pg_class c on t.tgrelid = c.oid join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and not t.tgisinternal
  ),
  storage_s as (
    select coalesce((select string_agg(b.id || ':' || b.public::text, E'\n' order by b.id) from storage.buckets b), '')
           || E'\n--\n' ||
           coalesce((select string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd || ':' || coalesce(p.qual, '')
                       || ':' || coalesce(p.with_check, ''), E'\n' order by p.tablename, p.policyname)
                     from pg_policies p where p.schemaname = 'storage'), '') as s,
           (select count(*) from storage.buckets) as n
  ),
  realtime_s as (
    select coalesce(string_agg(pt.schemaname || '.' || pt.tablename, E'\n' order by pt.tablename), '') as s,
           count(*) as n
    from pg_publication_tables pt
    where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'
  ),
  sections as (
    select jsonb_build_object(
      'tables',       jsonb_build_object('n', (select n from tables_s),        'md5', md5(coalesce((select s from tables_s), ''))),
      'columns',      jsonb_build_object('n', (select n from columns_s),       'md5', md5(coalesce((select s from columns_s), ''))),
      'constraints',  jsonb_build_object('n', (select n from constraints_s),   'md5', md5(coalesce((select s from constraints_s), ''))),
      'indexes',      jsonb_build_object('n', (select n from indexes_s),       'md5', md5(coalesce((select s from indexes_s), ''))),
      'functions',    jsonb_build_object('n', (select n from functions_s),     'md5', md5(coalesce((select s from functions_s), ''))),
      'fn_grants',    jsonb_build_object('n', (select n from fn_grants_s),     'md5', md5(coalesce((select s from fn_grants_s), ''))),
      'table_grants', jsonb_build_object('n', (select n from table_grants_s),  'md5', md5(coalesce((select s from table_grants_s), ''))),
      'policies',     jsonb_build_object('n', (select n from policies_s),      'md5', md5(coalesce((select s from policies_s), ''))),
      'triggers',     jsonb_build_object('n', (select n from triggers_s),      'md5', md5(coalesce((select s from triggers_s), ''))),
      'storage',      jsonb_build_object('n', (select n from storage_s),       'md5', md5(coalesce((select s from storage_s), ''))),
      'realtime',     jsonb_build_object('n', (select n from realtime_s),      'md5', md5(coalesce((select s from realtime_s), '')))
    ) as j
  )
  select jsonb_build_object(
    'sections', (select j from sections),
    'overall', md5((select j::text from sections)),
    'latest_migration', (select max(version) from supabase_migrations.schema_migrations)
  );
$$;

comment on function public.schema_fingerprint() is
  'Counts + md5 per schema section, for npm run verify:schema. Returns NO names and NO data — only shape hashes, so it is safe to expose to any signed-in caller. The instrument that makes repo-vs-production drift visible; before it existed, 30 migrations reached production with no repo file and nothing reported it.';

revoke all on function public.schema_fingerprint() from public, anon;
grant execute on function public.schema_fingerprint() to authenticated, service_role;