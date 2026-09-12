-- DORMANT. Common quote coordination, not an email installation or migration.
-- Install one explicit fixed profile separately, during reviewed quiescence.
-- No receipt storage, retention change, new relation lock or runtime DDL fence.
begin;

create function public._pilot_quote_owner_lock(p_owner uuid) returns void
language sql volatile set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended('pilot-email:'||p_owner::text,0));
$$;

-- An OID-free logical inventory of the entire known email footprint. Empty
-- arrays mean absent objects, never an automatically selected absent profile.
-- NOT NULL is represented by attnotnull on both PG17 and PG18: PG18 additionally
-- creates pg_constraint contype='n' rows, which do not exist on PG17.
create function public._pilot_quote_email_catalogue() returns jsonb
language sql stable set search_path='' as $$
with relations as (
  select c.*,n.nspname from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and (c.relname ~ '^pilot_(email_|quote_followup_)'
    -- Reserved core index names found as a table/view/sequence are malformed
    -- footprint, too. Correct indexes are inventoried in the indexes section.
    or c.relname=any(array['pilot_quotes_owner_customer_id_key','pilot_messages_owner_customer_id_key',
      'pilot_logs_owner_customer_id_key','pilot_one_active_email_connection','pilot_workflows_owner_state',
      'pilot_attempts_owner_started','pilot_received_email_once','pilot_events_retry']))
    and c.relkind not in ('i','I')
), constraints as (
  select k.* from pg_catalog.pg_constraint k
  where k.contype<>'n' and (k.conrelid in (select oid from relations)
    or k.confrelid in (select oid from relations)
    or k.conname ~ '^pilot_(email_|quote_followup_)')
), indexes as (
  select i.*,c.relname,n.nspname,c.relowner,c.relkind,c.reloptions,c.relam
  from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and (i.indrelid in (select oid from relations)
    or c.relname ~ '^pilot_(email_|quote_followup_|quotes_|messages_|logs_|one_active_email_|workflows_|attempts_|received_email_|events_)')
), triggers as (
  select t.* from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and (t.tgrelid in (select oid from relations)
    or t.tgconstraint in (select oid from constraints)
    or t.tgname ~ '^pilot_(email_|connection_|workflow_|attempt_|event_|customer_archived)')
), functions as (
  select p.*,n.nspname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname ~ '^_?pilot_(email_|quote_followup_)'
)
select jsonb_build_object('version',1,
  'relations',coalesce((select jsonb_agg(jsonb_build_object(
    'schema',c.nspname,'name',c.relname,'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
    'persistence',c.relpersistence,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'replica_identity',c.relreplident,'options',c.reloptions,
    'is_partition',c.relispartition,'partition_bound',pg_catalog.pg_get_expr(c.relpartbound,c.oid),
    'partition_key',pg_catalog.pg_get_partkeydef(c.oid),
    'acl_is_null',c.relacl is null,
    'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_catalog.pg_get_userbyid(a.grantor),
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type,a.is_grantable),'[]'::jsonb)
      from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(select coalesce(jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,
      'dropped',a.attisdropped,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
      'identity',a.attidentity,'generated',a.attgenerated,'default',replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid),E'\r\n',E'\n'),
      'collation',(select n.nspname||'.'||co.collname from pg_catalog.pg_collation co join pg_catalog.pg_namespace n on n.oid=co.collnamespace where co.oid=a.attcollation),
      'acl_is_null',a.attacl is null,
      'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_catalog.pg_get_userbyid(x.grantor),
        'grantee',case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end,
        'privilege',x.privilege_type,'grantable',x.is_grantable)
        order by x.grantor::regrole::text,x.grantee::regrole::text,x.privilege_type,x.is_grantable),'[]'::jsonb)
        from pg_catalog.aclexplode(case when cardinality(a.attacl)>0 then a.attacl else null end) x)) order by a.attnum),'[]'::jsonb)
      from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=c.oid and a.attnum>0)) order by c.nspname,c.relname) from relations c),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'table',c.relname,'name',k.conname,'type',k.contype,
    'definition',replace(pg_catalog.pg_get_constraintdef(k.oid),E'\r\n',E'\n'),
    'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
    'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true),
    'reference_schema',rn.nspname,'reference_table',rc.relname,
    'parent_schema',pn.nspname,'parent_table',pc.relname,'parent_constraint',pk.conname)
    order by n.nspname,c.relname,k.conname)
    from constraints k left join pg_catalog.pg_class c on c.oid=k.conrelid
    left join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    left join pg_catalog.pg_class rc on rc.oid=k.confrelid left join pg_catalog.pg_namespace rn on rn.oid=rc.relnamespace
    left join pg_catalog.pg_constraint pk on pk.oid=k.conparentid left join pg_catalog.pg_class pc on pc.oid=pk.conrelid
    left join pg_catalog.pg_namespace pn on pn.oid=pc.relnamespace),'[]'::jsonb),
  'indexes',coalesce((select jsonb_agg(jsonb_build_object(
    'schema',i.nspname,'name',i.relname,'table_schema',n.nspname,'table',c.relname,
    'owner',pg_catalog.pg_get_userbyid(i.relowner),'kind',i.relkind,'method',am.amname,'options',i.reloptions,
    'definition',replace(pg_catalog.pg_get_indexdef(i.indexrelid),E'\r\n',E'\n'),
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'unique',i.indisunique,
    'primary',i.indisprimary,'exclusion',i.indisexclusion,'immediate',i.indimmediate,
    'nulls_not_distinct',i.indnullsnotdistinct)
    order by i.nspname,i.relname) from indexes i join pg_catalog.pg_class c on c.oid=i.indrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace left join pg_catalog.pg_am am on am.oid=i.relam),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(jsonb_build_object(
    'table_schema',n.nspname,'table',c.relname,
    -- Internal RI names contain generated OIDs. Bind their complete constraint,
    -- relation, function, event bits and enforcement state instead of the name.
    'name',case when t.tgisinternal then null else t.tgname end,'internal',t.tgisinternal,
    'constraint_schema',kn.nspname,'constraint_table',kc.relname,'constraint_name',k.conname,
    'function_schema',fn.nspname,'function',p.proname,'function_arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
    'type',t.tgtype,'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
    'columns',t.tgattr::text,'arguments',encode(t.tgargs,'hex'),
    'definition',case when t.tgisinternal then null else replace(pg_catalog.pg_get_triggerdef(t.oid),E'\r\n',E'\n') end)
    order by n.nspname,c.relname,k.conname,p.proname,t.tgtype,t.tgdeferrable,t.tginitdeferred,
      case when t.tgisinternal then '' else t.tgname end)
    from triggers t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace fn on fn.oid=p.pronamespace
    left join pg_catalog.pg_constraint k on k.oid=t.tgconstraint left join pg_catalog.pg_class kc on kc.oid=k.conrelid
    left join pg_catalog.pg_namespace kn on kn.oid=kc.relnamespace),'[]'::jsonb),
  'rules',coalesce((select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
    'name',r.rulename,'event',r.ev_type,'enabled',r.ev_enabled,'instead',r.is_instead,
    'definition',replace(pg_catalog.pg_get_ruledef(r.oid),E'\r\n',E'\n'))
    order by n.nspname,c.relname,r.rulename) from pg_catalog.pg_rewrite r
    join pg_catalog.pg_class c on c.oid=r.ev_class join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where r.ev_class in (select oid from relations)),'[]'::jsonb),
  'inheritance',coalesce((select jsonb_agg(jsonb_build_object(
    'parent_schema',pn.nspname,'parent',p.relname,'child_schema',cn.nspname,'child',c.relname,
    'sequence',i.inhseqno,'detach_pending',i.inhdetachpending,'child_is_partition',c.relispartition,
    'child_partition_bound',pg_catalog.pg_get_expr(c.relpartbound,c.oid))
    order by pn.nspname,p.relname,cn.nspname,c.relname,i.inhseqno)
    from pg_catalog.pg_inherits i join pg_catalog.pg_class p on p.oid=i.inhparent
    join pg_catalog.pg_namespace pn on pn.oid=p.relnamespace
    join pg_catalog.pg_class c on c.oid=i.inhrelid join pg_catalog.pg_namespace cn on cn.oid=c.relnamespace
    where i.inhparent in (select oid from relations) or i.inhrelid in (select oid from relations)),'[]'::jsonb),
  'policies',coalesce((select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
    'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',(select jsonb_agg(case when u=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(u) end
      order by case when u=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(u) end) from unnest(p.polroles) u),
    'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
    order by n.nspname,c.relname,p.polname) from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where p.polrelid in (select oid from relations) or p.polname ~ '^pilot_(email_|quote_followup_)'),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_object('schema',p.nspname,'name',p.proname,
    'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'result',pg_catalog.pg_get_function_result(p.oid),
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,
    'security_definer',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,
    'leakproof',p.proleakproof,'parallel',p.proparallel,'config',p.proconfig,
    'definition',case when p.prokind in ('f','p') then replace(pg_catalog.pg_get_functiondef(p.oid),E'\r\n',E'\n') else null end,
    'acl_is_null',p.proacl is null,
    'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_catalog.pg_get_userbyid(a.grantor),
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type,a.is_grantable),'[]'::jsonb)
      from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a))
    order by p.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid))
    from functions p join pg_catalog.pg_language l on l.oid=p.prolang),'[]'::jsonb));
$$;

create function public._pilot_quote_email_profile() returns text
language plpgsql stable set search_path='' as $$
declare declaration jsonb; actual jsonb; expected_oid oid; expected_owner oid; helper_owner oid;
begin
  expected_oid:=to_regprocedure('public._pilot_quote_email_expected_profile()');
  if expected_oid is null then raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
  select proowner into helper_owner from pg_catalog.pg_proc where oid=to_regprocedure('public._pilot_quote_email_profile()');
  select proowner into expected_owner from pg_catalog.pg_proc p where p.oid=expected_oid and p.prokind='f'
    and p.provolatile='i' and not p.prosecdef and p.prorettype='jsonb'::regtype
    and p.pronargs=0 and p.proconfig=array['search_path=""']
    and p.prolang=(select oid from pg_catalog.pg_language where lanname='sql');
  if expected_owner is distinct from helper_owner
    or has_function_privilege('anon',expected_oid,'execute')
    or has_function_privilege('authenticated',expected_oid,'execute')
    or has_function_privilege('service_role',expected_oid,'execute')
    or exists(select 1 from pg_catalog.pg_proc p,
      lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid=expected_oid and a.grantee<>helper_owner) then
    raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
  execute 'select public._pilot_quote_email_expected_profile()' into declaration;
  if declaration is null or jsonb_typeof(declaration)<>'object'
    or not declaration ?& array['version','profile','catalogue_sha256']
    or (declaration-array['version','profile','catalogue_sha256'])<>'{}'::jsonb
    or declaration->'version'<>'1'::jsonb or jsonb_typeof(declaration->'profile')<>'string'
    or jsonb_typeof(declaration->'catalogue_sha256')<>'string'
    or coalesce(declaration->>'profile','') not in ('absent','present')
    or coalesce(declaration->>'catalogue_sha256','')!~'^[a-f0-9]{64}$' then
    raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
  actual:=public._pilot_quote_email_catalogue();
  if encode(sha256(convert_to(actual::text,'UTF8')),'hex') is distinct from declaration->>'catalogue_sha256'
    or (declaration->>'profile'='absent' and actual is distinct from
      '{"version":1,"relations":[],"constraints":[],"indexes":[],"triggers":[],"rules":[],"inheritance":[],"policies":[],"functions":[]}'::jsonb)
    or (declaration->>'profile'='present' and jsonb_array_length(actual->'relations')<>4) then
    raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
  return declaration->>'profile';
end $$;

create function public._pilot_quote_email_retained(p_owner uuid,p_quote uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare profile text; retained jsonb;
begin
  profile:=public._pilot_quote_email_profile();
  if profile='absent' then return jsonb_build_object('workflows','[]'::jsonb,'attempts','[]'::jsonb); end if;
  execute $query$select jsonb_build_object(
    'workflows',coalesce((select jsonb_agg(to_jsonb(w) order by w.id)
      from public.pilot_quote_followup_workflows w where w.user_id=$1 and w.quote_id=$2),'[]'::jsonb),
    'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.pilot_email_send_attempts a
      where a.user_id=$1 and exists(select 1 from public.pilot_quote_followup_workflows w where w.id=a.workflow_id and w.quote_id=$2)),'[]'::jsonb))$query$
    into retained using p_owner,p_quote;
  return retained;
end $$;

revoke all on function public._pilot_quote_owner_lock(uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_quote_email_catalogue() from public,anon,authenticated,service_role;
revoke all on function public._pilot_quote_email_profile() from public,anon,authenticated,service_role;
revoke all on function public._pilot_quote_email_retained(uuid,uuid) from public,anon,authenticated,service_role;
commit;
