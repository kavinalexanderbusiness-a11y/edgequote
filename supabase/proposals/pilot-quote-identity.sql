-- Dormant proposal only. Apply after the unchanged PR120 pilot-email-core.sql.
-- No route, migration replay, backfill, retention-policy change or activation.
-- Trusted server code plans with the actual TypeScript resolver, without writes.
-- This RPC commits identity preparation AND quote identity; it is not full Save.
begin;

create function public._pilot_qi_keys(p_value jsonb,p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='object' and p_value ?& p_keys
    and (p_value-p_keys)='{}'::jsonb,false);
$$;

create function public._pilot_qi_uuid(p_value jsonb,p_nullable boolean default false) returns boolean
language sql immutable set search_path='' as $$
  select coalesce((p_nullable and p_value='null'::jsonb) or
    (jsonb_typeof(p_value)='string' and (p_value#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),false);
$$;

create function public._pilot_qi_text(p_value jsonb,p_nullable boolean default false) returns boolean
language sql immutable set search_path='' as $$
  select coalesce((p_nullable and p_value='null'::jsonb) or
    (jsonb_typeof(p_value)='string' and length(p_value#>>'{}')<=10000),false);
$$;

create function public._pilot_qi_quote(p_row public.quotes) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select case when (p_row).id is null then 'null'::jsonb else jsonb_build_object(
    'id',(p_row).id,'user_id',(p_row).user_id,'updated_at',(p_row).updated_at,
    'customer_id',(p_row).customer_id,'customer_name',(p_row).customer_name,
    'property_id',(p_row).property_id,'address',(p_row).address) end;
$$;

create function public._pilot_qi_customer(p_row public.customers) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select case when (p_row).id is null then 'null'::jsonb else jsonb_build_object(
    'id',(p_row).id,'user_id',(p_row).user_id,'updated_at',(p_row).updated_at,
    'archived_at',(p_row).archived_at,'name',(p_row).name,'phone',(p_row).phone,
    'email',(p_row).email,'address',(p_row).address,'acquisition_source',(p_row).acquisition_source) end;
$$;

create function public._pilot_qi_property(p_row public.properties) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select case when (p_row).id is null then 'null'::jsonb else jsonb_build_object(
    'id',(p_row).id,'user_id',(p_row).user_id,'customer_id',(p_row).customer_id,
    'updated_at',(p_row).updated_at,'address',(p_row).address,'is_primary',(p_row).is_primary) end;
$$;

create function public._pilot_qi_projection_valid(p_value jsonb,p_kind text) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;
begin
  if p_kind='quote' then
    if not public._pilot_qi_keys(p_value,array['id','user_id','updated_at','customer_id','customer_name','property_id','address'])
      or not public._pilot_qi_uuid(p_value->'customer_id',true)
      or not public._pilot_qi_uuid(p_value->'property_id',true)
      or not public._pilot_qi_text(p_value->'customer_name')
      or not public._pilot_qi_text(p_value->'address') then return false; end if;
  elsif p_kind='customer' then
    if not public._pilot_qi_keys(p_value,array['id','user_id','updated_at','archived_at','name','phone','email','address','acquisition_source'])
      or not public._pilot_qi_text(p_value->'name')
      or not public._pilot_qi_text(p_value->'archived_at',true) then return false; end if;
    foreach k in array array['phone','email','address','acquisition_source'] loop
      if not public._pilot_qi_text(p_value->k,true) then return false; end if;
    end loop;
  elsif p_kind='property' then
    if not public._pilot_qi_keys(p_value,array['id','user_id','customer_id','updated_at','address','is_primary'])
      or not public._pilot_qi_uuid(p_value->'customer_id')
      or not public._pilot_qi_text(p_value->'address')
      or jsonb_typeof(p_value->'is_primary') is distinct from 'boolean' then return false; end if;
  else return false;
  end if;
  return public._pilot_qi_uuid(p_value->'id') and public._pilot_qi_uuid(p_value->'user_id')
    and public._pilot_qi_text(p_value->'updated_at');
end $$;

create function public._pilot_qi_rows(p_rows jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
    from jsonb_array_elements(p_rows);
$$;

-- Read-only planning snapshot. Missing/malformed ownership is never an empty set.
create function public.pilot_quote_identity_snapshot(p_owner uuid,p_quote uuid) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare q public.quotes; old_c public.customers; cs jsonb; ps jsonb; v jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    return jsonb_build_object('code','unsupported_isolation'); end if;
  select * into q from public.quotes where id=p_quote and user_id=p_owner;
  if not found then return jsonb_build_object('code','not_found'); end if;
  if not public._pilot_qi_projection_valid(public._pilot_qi_quote(q),'quote') then
    return jsonb_build_object('code','not_found'); end if;
  if q.customer_id is not null then
    select * into old_c from public.customers where id=q.customer_id and user_id=p_owner;
    if not found then return jsonb_build_object('code','not_found'); end if;
  end if;
  select coalesce(jsonb_agg(public._pilot_qi_customer(c::public.customers) order by c.name,c.id),'[]'::jsonb) into cs
    from (select * from public.customers where user_id=p_owner and archived_at is null order by name,id limit 10001) c;
  select coalesce(jsonb_agg(public._pilot_qi_property(p::public.properties) order by p.created_at,p.id),'[]'::jsonb) into ps
    from (select * from public.properties where user_id=p_owner order by created_at,id limit 10001) p;
  if jsonb_array_length(cs)>10000 or jsonb_array_length(ps)>10000 then
    return jsonb_build_object('code','stale_resolution'); end if;
  for v in select value from jsonb_array_elements(cs) loop
    if not public._pilot_qi_projection_valid(v,'customer') then return jsonb_build_object('code','not_found'); end if;
  end loop;
  for v in select value from jsonb_array_elements(ps) loop
    if not public._pilot_qi_projection_valid(v,'property') or not exists(
      select 1 from public.customers where id=(v->>'customer_id')::uuid and user_id=p_owner)
      then return jsonb_build_object('code','not_found'); end if;
  end loop;
  if old_c.id is not null and not public._pilot_qi_projection_valid(public._pilot_qi_customer(old_c),'customer') then
    return jsonb_build_object('code','not_found'); end if;
  if q.property_id is not null and not exists(select 1 from jsonb_array_elements(ps) x
    where x->>'id'=q.property_id::text and x->>'customer_id'=q.customer_id::text) then
    return jsonb_build_object('code','not_found'); end if;
  return jsonb_build_object('code','snapshot','complete',true,'quote',public._pilot_qi_quote(q),
    'quote_revision',md5(to_jsonb(q)::text),'customers',cs,'old_customer',public._pilot_qi_customer(old_c),'properties',ps);
end $$;

create function public.pilot_quote_identity_save(p_owner uuid,p_quote uuid,p_plan jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare q public.quotes; old_c public.customers; target_c public.customers; old_p public.properties;
  eq jsonb; ec jsonb; eoc jsonb; eop jsonb; eps jsonb; ecs jsonb;
  ci jsonb; cp jsonb; pi jsonb; r jsonb; v jsonb; k text;
  target_id uuid; target_property_id uuid; old_id uuid; old_property_id uuid;
  cs jsonb; ps jsonb; prior_q jsonb; changed boolean; preserving boolean; automatic boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    return jsonb_build_object('code','unsupported_isolation'); end if;
  if p_owner is null or p_quote is null or not public._pilot_qi_keys(p_plan,array[
    'version','preserve','automatic','expected_quote','expected_quote_revision','expected_old_customer',
    'expected_customer','expected_customers','expected_properties','expected_old_property',
    'customer_insert','customer_patch','property_insert','resolved']) then
    return jsonb_build_object('code','invalid_plan'); end if;
  if p_plan->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_plan->'preserve') is distinct from 'boolean'
    or jsonb_typeof(p_plan->'automatic') is distinct from 'boolean'
    or jsonb_typeof(p_plan->'expected_quote_revision') is distinct from 'string'
    or (p_plan->>'expected_quote_revision') !~ '^[a-f0-9]{32}$' then
    return jsonb_build_object('code','invalid_plan'); end if;
  eq:=p_plan->'expected_quote'; ec:=p_plan->'expected_customer'; eoc:=p_plan->'expected_old_customer';
  eop:=p_plan->'expected_old_property'; eps:=p_plan->'expected_properties'; ecs:=p_plan->'expected_customers';
  ci:=p_plan->'customer_insert'; cp:=p_plan->'customer_patch'; pi:=p_plan->'property_insert'; r:=p_plan->'resolved';
  preserving:=(p_plan->>'preserve')::boolean; automatic:=(p_plan->>'automatic')::boolean;
  if not public._pilot_qi_projection_valid(eq,'quote') or eq->>'id' is distinct from p_quote::text
    or eq->>'user_id' is distinct from p_owner::text
    or not public._pilot_qi_keys(r,array['customer_id','customer_name','property_id','address','created_customer','created_property','matched_by'])
    or not public._pilot_qi_uuid(r->'customer_id',preserving) or not public._pilot_qi_uuid(r->'property_id',true)
    or not public._pilot_qi_text(r->'customer_name') or not public._pilot_qi_text(r->'address')
    or jsonb_typeof(r->'created_customer') is distinct from 'boolean'
    or jsonb_typeof(r->'created_property') is distinct from 'boolean'
    or (r->'matched_by'<>'null'::jsonb and (jsonb_typeof(r->'matched_by') is distinct from 'string'
      or r->>'matched_by' not in ('phone','email','address'))) then return jsonb_build_object('code','invalid_plan'); end if;
  target_id:=(r->>'customer_id')::uuid; target_property_id:=(r->>'property_id')::uuid;
  old_id:=(eq->>'customer_id')::uuid; old_property_id:=(eq->>'property_id')::uuid;
  if (ec<>'null'::jsonb and not public._pilot_qi_projection_valid(ec,'customer'))
    or (eoc<>'null'::jsonb and not public._pilot_qi_projection_valid(eoc,'customer'))
    or (eop<>'null'::jsonb and not public._pilot_qi_projection_valid(eop,'property'))
    or jsonb_typeof(eps) is distinct from 'array'
    or (automatic and jsonb_typeof(ecs) is distinct from 'array')
    or (not automatic and ecs<>'null'::jsonb) then return jsonb_build_object('code','invalid_plan'); end if;
  if jsonb_array_length(eps)>10000 then return jsonb_build_object('code','invalid_plan'); end if;
  if automatic then
    if jsonb_array_length(ecs)>10000 then return jsonb_build_object('code','invalid_plan'); end if;
    for v in select value from jsonb_array_elements(ecs) loop
      if not public._pilot_qi_projection_valid(v,'customer') or v->>'user_id' is distinct from p_owner::text
        or v->'archived_at'<>'null'::jsonb then return jsonb_build_object('code','invalid_plan'); end if;
    end loop;
    if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(ecs)) then
      return jsonb_build_object('code','invalid_plan'); end if;
  end if;
  for v in select value from jsonb_array_elements(eps) loop
    if not public._pilot_qi_projection_valid(v,'property') or v->>'user_id' is distinct from p_owner::text
      or v->>'customer_id' is distinct from target_id::text then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(eps))
    or (ec<>'null'::jsonb and (ec->>'id' is distinct from target_id::text or ec->>'user_id' is distinct from p_owner::text))
    or (eoc<>'null'::jsonb and (eoc->>'id' is distinct from old_id::text or eoc->>'user_id' is distinct from p_owner::text))
    or (eop<>'null'::jsonb and (eop->>'id' is distinct from old_property_id::text
      or eop->>'user_id' is distinct from p_owner::text or eop->>'customer_id' is distinct from old_id::text))
    or ((old_id is null) is distinct from (eoc='null'::jsonb))
    or ((old_property_id is null) is distinct from (eop='null'::jsonb)) then
    return jsonb_build_object('code','invalid_plan'); end if;

  if ci<>'null'::jsonb then
    if not public._pilot_qi_keys(ci,array['id','name','email','phone','address','city','province','postal_code','acquisition_source','user_id'])
      or not public._pilot_qi_uuid(ci->'id') or ci->>'id' is distinct from target_id::text
      or ci->>'user_id' is distinct from p_owner::text or not public._pilot_qi_text(ci->'name')
      or ci->>'name' is distinct from r->>'customer_name' or not automatic or ec<>'null'::jsonb
      or cp<>'null'::jsonb or eps<>'[]'::jsonb or r->'matched_by'<>'null'::jsonb
      or target_id in (p_owner,p_quote,old_id,old_property_id) then return jsonb_build_object('code','invalid_plan'); end if;
    foreach k in array array['email','phone','address','city','province','postal_code','acquisition_source'] loop
      if not public._pilot_qi_text(ci->k,true) then return jsonb_build_object('code','invalid_plan'); end if;
    end loop;
    if ci->>'acquisition_source' is distinct from public.sanitize_source_input(ci->>'acquisition_source')
      or coalesce(ci->>'address','') is distinct from r->>'address' then return jsonb_build_object('code','invalid_plan'); end if;
  elsif target_id is not null and ec='null'::jsonb then return jsonb_build_object('code','invalid_plan');
  end if;
  if cp<>'null'::jsonb then
    if jsonb_typeof(cp) is distinct from 'object' or cp='{}'::jsonb
      or (cp-array['phone','email','acquisition_source'])<>'{}'::jsonb or not automatic
      or ci<>'null'::jsonb or ec='null'::jsonb then return jsonb_build_object('code','invalid_plan'); end if;
    for k,v in select key,value from jsonb_each(cp) loop
      if not public._pilot_qi_text(v) or (v#>>'{}')='' then return jsonb_build_object('code','invalid_plan'); end if;
      if k='acquisition_source' and (v#>>'{}') is distinct from public.sanitize_source_input(v#>>'{}') then
        return jsonb_build_object('code','invalid_plan'); end if;
    end loop;
  end if;
  if pi<>'null'::jsonb then
    if not public._pilot_qi_keys(pi,array['id','customer_id','user_id','address','city','province','postal_code','is_primary'])
      or not public._pilot_qi_uuid(pi->'id') or pi->>'id' is distinct from target_property_id::text
      or pi->>'customer_id' is distinct from target_id::text or pi->>'user_id' is distinct from p_owner::text
      or not public._pilot_qi_text(pi->'address') or pi->>'address' is distinct from r->>'address'
      or (pi->>'address')='' or jsonb_typeof(pi->'is_primary') is distinct from 'boolean'
      or pi->'is_primary' is distinct from to_jsonb(jsonb_array_length(eps)=0)
      or target_property_id in (p_owner,p_quote,target_id,old_id,old_property_id) then return jsonb_build_object('code','invalid_plan'); end if;
    foreach k in array array['city','province','postal_code'] loop
      if not public._pilot_qi_text(pi->k,true) then return jsonb_build_object('code','invalid_plan'); end if;
    end loop;
  end if;
  if r->'created_customer' is distinct from to_jsonb(ci<>'null'::jsonb)
    or r->'created_property' is distinct from to_jsonb(pi<>'null'::jsonb)
    or (not automatic and r->'matched_by'<>'null'::jsonb)
    or (automatic and ci='null'::jsonb and r->'matched_by'='null'::jsonb) then
    return jsonb_build_object('code','invalid_plan'); end if;
  if preserving and (automatic or ci<>'null'::jsonb or cp<>'null'::jsonb or pi<>'null'::jsonb
    or r->'customer_id' is distinct from eq->'customer_id' or r->'property_id' is distinct from eq->'property_id'
    or r->'customer_name' is distinct from eq->'customer_name' or r->'address' is distinct from eq->'address') then
    return jsonb_build_object('code','invalid_plan'); end if;

  -- Same owner serialization as approval/start; never acquire it after row locks.
  perform public._pilot_email_owner_lock(p_owner);
  perform 1 from public.customers where user_id=p_owner and id in (old_id,target_id) order by id for update;
  -- Customer FOR UPDATE blocks the FK KEY SHARE of new target-property inserts.
  -- Existing property locks precede quote, matching property deletion's SET NULL.
  perform 1 from public.properties where user_id=p_owner
    and (customer_id=target_id or id=old_property_id) order by id for update;
  select * into q from public.quotes where id=p_quote and user_id=p_owner for update;
  if not found then return jsonb_build_object('code','not_found'); end if;
  if public._pilot_qi_quote(q) is distinct from eq or md5(to_jsonb(q)::text) is distinct from p_plan->>'expected_quote_revision' then
    return jsonb_build_object('code','stale_quote'); end if;
  prior_q:=to_jsonb(q);
  if old_id is not null then
    select * into old_c from public.customers where id=old_id and user_id=p_owner;
    if not found then return jsonb_build_object('code','stale_resolution'); end if;
  end if;
  if public._pilot_qi_customer(old_c) is distinct from eoc then return jsonb_build_object('code','stale_resolution'); end if;
  if old_property_id is not null then
    select * into old_p from public.properties where id=old_property_id and user_id=p_owner and customer_id=old_id;
    if not found then return jsonb_build_object('code','stale_resolution'); end if;
  end if;
  if public._pilot_qi_property(old_p) is distinct from eop then return jsonb_build_object('code','stale_resolution'); end if;
  if ci='null'::jsonb and target_id is not null then
    select * into target_c from public.customers where id=target_id and user_id=p_owner;
    if not found or (target_c.archived_at is not null and target_id is distinct from old_id)
      then return jsonb_build_object('code','stale_resolution'); end if;
    if public._pilot_qi_customer(target_c) is distinct from ec then return jsonb_build_object('code','stale_resolution'); end if;
    if not preserving and target_c.name is distinct from r->>'customer_name' then return jsonb_build_object('code','invalid_plan'); end if;
  elsif ci<>'null'::jsonb and (exists(select 1 from public.customers where id=target_id)
    or exists(select 1 from public.properties where id=target_id) or exists(select 1 from public.quotes where id=target_id)) then
    return jsonb_build_object('code','invalid_plan'); end if;
  if automatic then
    select coalesce(jsonb_agg(public._pilot_qi_customer(c::public.customers) order by c.id),'[]'::jsonb) into cs
      from (select * from public.customers where user_id=p_owner and archived_at is null order by id limit 10001) c;
    if jsonb_array_length(cs)>10000 or cs is distinct from public._pilot_qi_rows(ecs) then
      return jsonb_build_object('code','stale_resolution'); end if;
    if ci='null'::jsonb and not exists(select 1 from jsonb_array_elements(cs) x where x->>'id'=target_id::text) then
      return jsonb_build_object('code','stale_resolution'); end if;
  end if;
  select coalesce(jsonb_agg(public._pilot_qi_property(p::public.properties) order by p.id),'[]'::jsonb) into ps
    from (select * from public.properties where user_id=p_owner and customer_id=target_id order by id limit 10001) p;
  if jsonb_array_length(ps)>10000 or ps is distinct from public._pilot_qi_rows(eps) then
    return jsonb_build_object('code','stale_resolution'); end if;
  if target_property_id is not null and pi='null'::jsonb and not exists(
    select 1 from public.properties where id=target_property_id and user_id=p_owner and customer_id=target_id) then
    return jsonb_build_object('code','invalid_plan'); end if;
  if pi<>'null'::jsonb and (exists(select 1 from public.properties where id=target_property_id)
    or exists(select 1 from public.customers where id=target_property_id) or exists(select 1 from public.quotes where id=target_property_id)) then
    return jsonb_build_object('code','invalid_plan'); end if;
  if cp<>'null'::jsonb and ((cp ? 'phone' and coalesce(target_c.phone,'')<>'')
    or (cp ? 'email' and coalesce(target_c.email,'')<>'')
    -- Match JavaScript trim's blank-only rule; do not erase recorded controls.
    or (cp ? 'acquisition_source' and btrim(coalesce(target_c.acquisition_source,''),
      E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF')<>'')) then
    return jsonb_build_object('code','invalid_plan'); end if;

  -- Every retained state binds identity, including a never-sent approval.
  if target_id is distinct from q.customer_id and exists(
    select 1 from public.pilot_quote_followup_workflows where user_id=p_owner and quote_id=q.id) then
    return jsonb_build_object('code','retained_customer_binding'); end if;

  -- No exception handler below: a late error rolls back ALL of these writes.
  if ci<>'null'::jsonb then
    insert into public.customers(id,user_id,name,email,phone,address,city,province,postal_code,acquisition_source)
      values(target_id,p_owner,ci->>'name',ci->>'email',ci->>'phone',ci->>'address',ci->>'city',
        ci->>'province',ci->>'postal_code',ci->>'acquisition_source);
  elsif cp<>'null'::jsonb then
    update public.customers set phone=case when cp ? 'phone' then cp->>'phone' else phone end,
      email=case when cp ? 'email' then cp->>'email' else email end,
      acquisition_source=case when cp ? 'acquisition_source' then cp->>'acquisition_source' else acquisition_source end
      where id=target_id and user_id=p_owner;
    if not found then raise exception 'pilot_quote_identity_customer_write_missing' using errcode='P0001'; end if;
  end if;
  if pi<>'null'::jsonb then
    insert into public.properties(id,user_id,customer_id,address,city,province,postal_code,is_primary)
      values(target_property_id,p_owner,target_id,pi->>'address',pi->>'city',pi->>'province',pi->>'postal_code',(pi->>'is_primary')::boolean);
  end if;
  changed:=q.customer_id is distinct from target_id or q.property_id is distinct from target_property_id
    or q.customer_name is distinct from r->>'customer_name' or q.address is distinct from r->>'address';
  if changed then
    update public.quotes set customer_id=target_id,customer_name=r->>'customer_name',property_id=target_property_id,address=r->>'address'
      where id=q.id and user_id=p_owner returning * into q;
    if not found then raise exception 'pilot_quote_identity_quote_write_missing' using errcode='P0001'; end if;
    if (to_jsonb(q)-array['customer_id','customer_name','property_id','address','updated_at'])
      is distinct from (prior_q-array['customer_id','customer_name','property_id','address','updated_at']) then
      raise exception 'pilot_quote_identity_protected_quote_changed' using errcode='P0001'; end if;
  end if;
  return jsonb_build_object('code',case when changed or ci<>'null'::jsonb or cp<>'null'::jsonb or pi<>'null'::jsonb then 'saved' else 'unchanged' end,
    'quote_id',q.id,'customer_id',q.customer_id,'customer_name',q.customer_name,'property_id',q.property_id,'updated_at',q.updated_at,
    'created_customer',ci<>'null'::jsonb,'created_property',pi<>'null'::jsonb,'matched_by',r->'matched_by');
end $$;

revoke all on function public._pilot_qi_keys(jsonb,text[]) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_uuid(jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_text(jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_quote(public.quotes) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_customer(public.customers) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_property(public.properties) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_projection_valid(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qi_rows(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_identity_snapshot(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_identity_save(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pilot_quote_identity_snapshot(uuid,uuid) to service_role;
grant execute on function public.pilot_quote_identity_save(uuid,uuid,jsonb) to service_role;

commit;
