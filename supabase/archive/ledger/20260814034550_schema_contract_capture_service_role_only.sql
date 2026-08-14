-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034550
--   name    : schema_contract_capture_service_role_only
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- schema_contract() — the full catalogue, for `npm run schema:contract`
--
-- Companion to schema_fingerprint(). The fingerprint answers "did something
-- change?" in hashes that leak nothing. THIS answers "what, exactly?" — and that
-- is a materially different disclosure: it returns every RLS predicate and every
-- SECURITY DEFINER body, which together are the authorization logic of the whole
-- product. Someone studying them learns precisely which predicate to attack.
--
-- So the two functions are graded deliberately:
--   schema_fingerprint()  authenticated + service_role  — hashes and counts only
--   schema_contract()     service_role ONLY             — the actual definitions
--
-- A crew session is `authenticated`. It must never be able to read this.
--
-- WHY IT EXISTS AT ALL: keeping the repo in step with production has to be one
-- command, or it stops happening. The previous process was a hand-run sequence of
-- catalogue queries, and the result was 30 migrations in production with no repo
-- file. A resync that is tedious is a resync that gets skipped.
--
-- READ-ONLY: no writes, no DDL. Marked STABLE.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.schema_contract()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'misc', jsonb_build_object(
      'captured_at', now()::text,
      'pg_version', version(),
      'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
      'seq_acls', (select jsonb_agg(jsonb_build_object('name', c.relname, 'acl', c.relacl::text) order by c.relname)
                   from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relkind='S'),
      'default_acls', (select jsonb_agg(jsonb_build_object('role', r.rolname, 'schema', coalesce(n.nspname,'<global>'),
                          'objtype', d.defaclobjtype::text, 'acl', d.defaclacl::text))
                       from pg_default_acl d join pg_roles r on d.defaclrole=r.oid
                       left join pg_namespace n on d.defaclnamespace=n.oid),
      'buckets', (select jsonb_agg(to_jsonb(b) order by b.id) from
                  (select id, name, public, file_size_limit, allowed_mime_types, avif_autodetection
                   from storage.buckets) b),
      'extensions', (select jsonb_agg(jsonb_build_object('name', extname, 'version', extversion,
                        'schema', (select nspname from pg_namespace where oid=extnamespace)) order by extname)
                     from pg_extension),
      'publication_tables', (select jsonb_agg(schemaname || '.' || tablename order by tablename)
                             from pg_publication_tables where pubname='supabase_realtime')
    ),
    'misc2', jsonb_build_object(
      'column_acls', (select jsonb_agg(jsonb_build_object('tbl', c.relname, 'col', a.attname, 'acl', a.attacl::text)
                         order by c.relname, a.attname)
                      from pg_attribute a join pg_class c on a.attrelid=c.oid join pg_namespace n on c.relnamespace=n.oid
                      where n.nspname='public' and c.relkind='r' and a.attacl is not null),
      'replica_identity', (select jsonb_agg(jsonb_build_object('tbl', c.relname, 'ident', c.relreplident::text) order by c.relname)
                           from pg_class c join pg_namespace n on c.relnamespace=n.oid
                           where n.nspname='public' and c.relkind='r' and c.relreplident <> 'd'),
      'default_acls', (select jsonb_agg(jsonb_build_object('role', r.rolname, 'schema', coalesce(n.nspname,'<global>'),
                          'objtype', d.defaclobjtype::text, 'acl', d.defaclacl::text))
                       from pg_default_acl d join pg_roles r on d.defaclrole=r.oid
                       left join pg_namespace n on d.defaclnamespace=n.oid),
      'sequences', (select jsonb_agg(jsonb_build_object('name', s.sequencename, 'data_type', s.data_type::text) order by s.sequencename)
                    from pg_sequences s where s.schemaname='public'),
      'role_settings', (select jsonb_agg(jsonb_build_object('role', r.rolname, 'config', s.setconfig))
                        from pg_db_role_setting s join pg_roles r on s.setrole=r.oid)
    ),
    'tables', (select jsonb_agg(jsonb_build_object(
        'relname', c.relname, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity, 'acl', c.relacl::text,
        'cols', (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                    'notnull', a.attnotnull, 'default', pg_get_expr(ad.adbin, ad.adrelid),
                    'generated', a.attgenerated, 'identity', a.attidentity) order by a.attnum)
                 from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum
                 where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
      ) order by c.relname)
      from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relkind='r'),
    'constraints', (select jsonb_agg(jsonb_build_object('tbl', cl.relname, 'conname', con.conname,
        'contype', con.contype::text, 'def', pg_get_constraintdef(con.oid), 'convalidated', con.convalidated)
        order by cl.relname, con.conname)
      from pg_constraint con join pg_class cl on con.conrelid=cl.oid join pg_namespace n on cl.relnamespace=n.oid
      where n.nspname='public'),
    'indexes', (select jsonb_agg(jsonb_build_object('tbl', i.tablename, 'indexname', i.indexname, 'indexdef', i.indexdef,
        'backs_constraint', exists(select 1 from pg_constraint con join pg_class ic on con.conindid=ic.oid
                                   where ic.relname=i.indexname))
        order by i.tablename, i.indexname)
      from pg_indexes i where i.schemaname='public'),
    'policies', (select jsonb_agg(jsonb_build_object('schemaname', p.schemaname, 'tablename', p.tablename,
        'policyname', p.policyname, 'permissive', p.permissive, 'roles', p.roles::text, 'cmd', p.cmd,
        'qual', p.qual, 'with_check', p.with_check)
        order by p.schemaname, p.tablename, p.policyname)
      from pg_policies p where p.schemaname in ('public','storage')),
    'triggers', (select jsonb_agg(jsonb_build_object('tbl', c.relname, 'tgname', t.tgname,
        'def', pg_get_triggerdef(t.oid), 'tgenabled', t.tgenabled::text) order by c.relname, t.tgname)
      from pg_trigger t join pg_class c on t.tgrelid=c.oid join pg_namespace n on c.relnamespace=n.oid
      where n.nspname='public' and not t.tgisinternal),
    'functions', (select jsonb_agg(jsonb_build_object('proname', p.proname,
        'args', pg_get_function_identity_arguments(p.oid), 'def', pg_get_functiondef(p.oid),
        'acl', p.proacl::text, 'owner', r.rolname)
        order by p.proname, pg_get_function_identity_arguments(p.oid))
      from pg_proc p join pg_namespace n on p.pronamespace=n.oid join pg_roles r on p.proowner=r.oid
      where n.nspname='public' and p.prokind='f'),
    'extension_objects', (select jsonb_agg(jsonb_build_object('ext', e.extname, 'kind', c.k, 'name', c.objname)
        order by e.extname, c.objname)
      from (
        select d.refobjid as extoid, 'function' as k,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as objname
        from pg_depend d join pg_proc p on d.objid=p.oid and d.classid='pg_proc'::regclass where d.deptype='e'
        union all
        select d.refobjid, 'operator', o.oprname::text
        from pg_depend d join pg_operator o on d.objid=o.oid and d.classid='pg_operator'::regclass where d.deptype='e'
        union all
        select d.refobjid, c2.relkind::text, c2.relname::text
        from pg_depend d join pg_class c2 on d.objid=c2.oid and d.classid='pg_class'::regclass where d.deptype='e'
      ) c join pg_extension e on e.oid=c.extoid),
    'comments', jsonb_build_object(
      'table_comments', (select jsonb_agg(jsonb_build_object('tbl', c.relname, 'comment', d.description) order by c.relname)
        from pg_description d join pg_class c on d.objoid=c.oid join pg_namespace n on c.relnamespace=n.oid
        where n.nspname='public' and d.classoid='pg_class'::regclass and d.objsubid=0 and c.relkind='r'),
      'column_comments', (select jsonb_agg(jsonb_build_object('tbl', c.relname, 'col', a.attname, 'comment', d.description)
          order by c.relname, a.attname)
        from pg_description d join pg_class c on d.objoid=c.oid join pg_namespace n on c.relnamespace=n.oid
        join pg_attribute a on a.attrelid=c.oid and a.attnum=d.objsubid
        where n.nspname='public' and d.classoid='pg_class'::regclass and d.objsubid>0),
      'fn_comments', (select jsonb_agg(jsonb_build_object('fn', p.proname,
          'args', pg_get_function_identity_arguments(p.oid), 'comment', d.description) order by p.proname)
        from pg_description d join pg_proc p on d.objoid=p.oid join pg_namespace n on p.pronamespace=n.oid
        where n.nspname='public' and d.classoid='pg_proc'::regclass)
    ),
    'ledger', (select jsonb_agg(jsonb_build_object('version', m.version, 'name', m.name,
        'stmt_count', coalesce(array_length(m.statements,1),0),
        'sql_len', length(array_to_string(m.statements, E'\n')),
        'sql_md5', md5(array_to_string(m.statements, E'\n'))) order by m.version)
      from supabase_migrations.schema_migrations m)
  );
$$;

comment on function public.schema_contract() is
  'Full catalogue snapshot for npm run schema:contract. SERVICE_ROLE ONLY — it returns every RLS predicate and SECURITY DEFINER body, i.e. the product''s authorization logic. Use schema_fingerprint() (hashes only) for anything that merely needs to detect change.';

revoke all on function public.schema_contract() from public, anon, authenticated;
grant execute on function public.schema_contract() to service_role;