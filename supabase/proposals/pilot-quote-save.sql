-- DORMANT ONLY. Requires unchanged pilot-email-core.sql and pilot-quote-identity.sql.
-- No migration, mounted route, acceptance writer/legacy-door change or activation.
-- This is one Save transaction. Legacy acceptance still needs its own companion.
begin;

create function public._pilot_qs_pick(v jsonb, keys text[]) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce(jsonb_object_agg(k,v->k),'{}'::jsonb) from unnest(keys) k;
$$;

create function public._pilot_qs_pricing(p_owner uuid) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select jsonb_build_object('row',public._pilot_qs_pick(to_jsonb(b),array['user_id','pricing_base_charge',
    'pricing_mow_rate','pricing_recommended_mult','pricing_premium_mult','pricing_travel_rate',
    'crew_cost_per_hour','fee_recovery_percent','payment_fee_strategy']),'xmin',b.xmin::text)
    from public.business_settings b where b.user_id=p_owner;
$$;

-- Private common lock order for Save and the separately installed versioned
-- acceptance companion. Passed IDs may be new and absent, but never foreign.
-- The owner's auth row fences absent owner-FK rows only where the installed
-- schema's nondeferrable FK proof holds; it is not a substitute for that proof.
create function public._pilot_quote_save_lock(p_owner uuid,p_quote uuid,p_customer_ids uuid[],p_property_ids uuid[]) returns void
language plpgsql volatile set search_path='' as $$
declare current_property uuid;
begin
  perform public._pilot_email_owner_lock(p_owner);
  perform 1 from auth.users where id=p_owner for update;
  if not found then return; end if;
  if exists(select 1 from public.customers where id=any(p_customer_ids) and user_id<>p_owner)
    or exists(select 1 from public.properties where id=any(p_property_ids) and user_id<>p_owner)
    then raise exception 'pilot_quote_save_foreign_dependency' using errcode='42501'; end if;
  perform 1 from public.customers where user_id=p_owner order by id for update;
  perform 1 from public.properties where user_id=p_owner order by id for update;
  select property_id into current_property from public.quotes where id=p_quote and user_id=p_owner for update;
  perform 1 from public.quote_options where user_id=p_owner and quote_id=p_quote order by id for update;
  perform 1 from public.quote_services where user_id=p_owner and quote_id=p_quote order by id for update;
  perform 1 from public.quote_addons where user_id=p_owner and quote_id=p_quote order by id for update;
  perform 1 from public.service_templates where user_id=p_owner order by id for update;
  perform 1 from public.business_settings where user_id=p_owner for update;
  perform 1 from public.quote_acceptances where user_id=p_owner and quote_id=p_quote order by id for update;
  perform 1 from public.property_measurements where user_id=p_owner
    and (property_id=current_property or property_id=any(p_property_ids)) and kind='lawn' order by id for update;
end $$;

-- One statement snapshot. In particular, do not call the older VOLATILE
-- identity_snapshot here: its successive reads would obtain different snapshots.
create function public._pilot_qs_editor(p_owner uuid,p_quote uuid) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select jsonb_build_object(
    'quote',jsonb_build_object('row',to_jsonb(q),'xmin',q.xmin::text),
    'services',coalesce((select jsonb_agg(jsonb_build_object('row',to_jsonb(s),'xmin',s.xmin::text) order by s.sort_order,s.id)
      from public.quote_services s where s.quote_id=q.id and s.user_id=p_owner),'[]'::jsonb),
    'options',coalesce((select jsonb_agg(jsonb_build_object('row',to_jsonb(o),'xmin',o.xmin::text) order by o.sort_order,o.id)
      from public.quote_options o where o.quote_id=q.id and o.user_id=p_owner),'[]'::jsonb),
    'addons',coalesce((select jsonb_agg(jsonb_build_object('row',to_jsonb(a),'xmin',a.xmin::text) order by a.sort_order,a.id)
      from public.quote_addons a where a.quote_id=q.id and a.user_id=p_owner),'[]'::jsonb),
    'templates',coalesce((select jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.sort_order,t.id)
      from public.service_templates t where t.user_id=p_owner),'[]'::jsonb),
    'pricing_inputs',public._pilot_qs_pricing(p_owner),
    'acceptance',jsonb_build_object('latest',(select jsonb_build_object('row',to_jsonb(a),'xmin',a.xmin::text)
        from public.quote_acceptances a where a.quote_id=q.id and a.user_id=p_owner order by a.seq desc limit 1),
      'current',public.quote_acceptance_is_current(q.id),'material_fingerprint',public.quote_material_fingerprint(q.id),
      'terms_fingerprint',public.quote_terms_fingerprint(p_owner)),
    'identity',jsonb_build_object('code','snapshot','complete',true,'quote',public._pilot_qi_quote(q),
      'quote_revision',md5(to_jsonb(q)::text),
      'customers',coalesce((select jsonb_agg(public._pilot_qi_customer(c) order by c.name,c.id)
        from public.customers c where c.user_id=p_owner and c.archived_at is null),'[]'::jsonb),
      'old_customer',coalesce((select public._pilot_qi_customer(c) from public.customers c where c.id=q.customer_id and c.user_id=p_owner),'null'::jsonb),
      'properties',coalesce((select jsonb_agg(public._pilot_qi_property(p) order by p.created_at,p.id)
        from public.properties p where p.user_id=p_owner),'[]'::jsonb)))
  from public.quotes q where q.id=p_quote and q.user_id=p_owner;
$$;

create function public._pilot_qs_snapshot(p_owner uuid,p_quote uuid) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' as $$
declare s jsonb;
begin
  s:=public._pilot_qs_editor(p_owner,p_quote);
  if s is null then return jsonb_build_object('code','not_found'); end if;
  if jsonb_array_length(s#>'{identity,customers}')>10000 or jsonb_array_length(s#>'{identity,properties}')>10000
    then return jsonb_build_object('code','snapshot_too_large'); end if;
  -- Identity is a separate canonical matching observation, not a commercial edit
  -- version. It is still compared in full immediately before any preparation.
  s:=s||jsonb_build_object('code','snapshot','complete',true,'editor_revision',md5((s-'identity')::text));
  if octet_length(s::text)>16777216 then return jsonb_build_object('code','snapshot_too_large'); end if;
  return s;
end $$;

create function public.pilot_quote_save_snapshot(p_owner uuid,p_quote uuid) returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
begin
  if p_owner is null or p_quote is null or (auth.uid() is not null and auth.uid() is distinct from p_owner)
    then return jsonb_build_object('code','not_found'); end if;
  if current_setting('transaction_isolation')<>'read committed' then return jsonb_build_object('code','unsupported_isolation'); end if;
  return public._pilot_qs_snapshot(p_owner,p_quote);
end $$;

create function public._pilot_qs_targets(p_owner uuid,p_quote uuid,p_revision text,p_identity jsonb,p_templates uuid[]) returns jsonb
language sql stable set search_path='' set timezone='UTC' as $$
  select jsonb_build_object('customer',(select jsonb_build_object('row',to_jsonb(c),'xmin',c.xmin::text)
      from public.customers c where c.user_id=p_owner and c.id=(p_identity#>>'{resolved,customer_id}')::uuid),
    'property',(select jsonb_build_object('row',to_jsonb(p),'xmin',p.xmin::text)
      from public.properties p where p.user_id=p_owner and p.id=(p_identity#>>'{resolved,property_id}')::uuid
      and p.customer_id=(p_identity#>>'{resolved,customer_id}')::uuid),
    'lawn',(select jsonb_build_object('row',to_jsonb(m),'xmin',m.xmin::text)
      from public.property_measurements m where m.user_id=p_owner and m.property_id=(p_identity#>>'{resolved,property_id}')::uuid and m.kind='lawn'),
    'templates',coalesce((select jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.sort_order,t.id)
      from public.service_templates t where t.user_id=p_owner and t.id=any(p_templates)),'[]'::jsonb),
    'pricing_inputs',public._pilot_qs_pricing(p_owner),'editor_revision',p_revision);
$$;

create function public.pilot_quote_save_targets(p_owner uuid,p_quote uuid,p_expected_revision text,
  p_identity jsonb,p_template_ids uuid[],p_provenance_mode text) returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare s jsonb; t jsonb; r jsonb;
begin
  if p_owner is null or p_quote is null or (auth.uid() is not null and auth.uid() is distinct from p_owner)
    then return jsonb_build_object('code','not_found'); end if;
  if current_setting('transaction_isolation')<>'read committed' then return jsonb_build_object('code','unsupported_isolation'); end if;
  if p_identity is null or octet_length(p_identity::text)>16777216 or coalesce(p_expected_revision,'') !~ '^[a-f0-9]{32}$'
    or p_template_ids is null or array_position(p_template_ids,null) is not null
    or cardinality(p_template_ids)<>(select count(distinct x) from unnest(p_template_ids) x)
    or coalesce(p_provenance_mode,'') not in ('preserve','ensure_current') then return jsonb_build_object('code','invalid_plan'); end if;
  r:=p_identity->'resolved';
  if not public._pilot_qi_uuid(r->'customer_id',true) or not public._pilot_qi_uuid(r->'property_id',true)
    then return jsonb_build_object('code','invalid_plan'); end if;
  s:=public._pilot_qs_snapshot(p_owner,p_quote);
  if s->>'code'<>'snapshot' then return s; end if;
  if s->>'editor_revision' is distinct from p_expected_revision or s#>>'{identity,quote_revision}' is distinct from p_identity->>'expected_quote_revision'
    then return jsonb_build_object('code','stale_editor'); end if;
  t:=public._pilot_qs_targets(p_owner,p_quote,p_expected_revision,p_identity,p_template_ids);
  if jsonb_array_length(t->'templates')<>cardinality(p_template_ids)
    or (p_identity->'customer_insert'='null'::jsonb and r->'customer_id'<>'null'::jsonb and t->'customer'='null'::jsonb)
    or (p_identity->'property_insert'='null'::jsonb and r->'property_id'<>'null'::jsonb and t->'property'='null'::jsonb)
    or (p_identity->'customer_insert'<>'null'::jsonb and t->'customer'<>'null'::jsonb)
    or (p_identity->'property_insert'<>'null'::jsonb and (t->'property'<>'null'::jsonb or t->'lawn'<>'null'::jsonb))
    then return jsonb_build_object('code','stale_targets'); end if;
  if p_provenance_mode='ensure_current' and t->'pricing_inputs'='null'::jsonb then return jsonb_build_object('code','pricing_settings_unavailable'); end if;
  t:=t||jsonb_build_object('code','targets','complete',true,'target_revision',md5(t::text));
  if octet_length(t::text)>16777216 then return jsonb_build_object('code','snapshot_too_large'); end if;
  return t;
end $$;

-- Explicit owner-editor output; internal full snapshots above must stay server-only.
create function public._pilot_qs_editor_quote(q jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select public._pilot_qs_pick(q,array['id','user_id','quote_number','updated_at','customer_id','customer_name','property_id','address',
    'service_type','service_template_id','initial_price','weekly_price','biweekly_price','monthly_price','hours','crew_size','rate','travel_fee',
    'overgrowth_multiplier','custom_travel_required','show_travel_separately','notes','internal_notes','measured_sqft','measurement_snapshot',
    'suggested_price','value_grade','nearby_count','price_source','pricing_config_version_id','deposit_type','deposit_value','status',
    'selected_option_id','accepted_price','total','subtotal','man_hours']);
$$;

create function public._pilot_qs_retained(p_owner uuid,p_quote uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('workflows',coalesce((select jsonb_agg(to_jsonb(w) order by w.id)
      from public.pilot_quote_followup_workflows w where w.user_id=p_owner and w.quote_id=p_quote),'[]'::jsonb),
    'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.pilot_email_send_attempts a
      where a.user_id=p_owner and exists(select 1 from public.pilot_quote_followup_workflows w where w.id=a.workflow_id and w.quote_id=p_quote)),'[]'::jsonb));
$$;

create function public.pilot_quote_save(p_owner uuid,p_quote uuid,p_plan jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' as $$
declare s jsonb; t jsonb; before_q jsonb; after_s jsonb; retained jsonb; patch jsonb; identity_result jsonb;
  v jsonb; m jsonb; got jsonb; opt_rows jsonb:='[]'; service_rows jsonb:='[]'; deleted_ids jsonb;
  expected_ids jsonb; receipt jsonb; k text; mode text; n integer; i integer; version_id uuid;
  before_events jsonb; after_events jsonb; expected_event boolean;
  target_customer uuid; target_property uuid; template_ids uuid[]; q public.quotes; pq public.quotes;
  opt public.quote_options; svc public.quote_services; meas public.property_measurements;
  base_keys text[]:=array['customer_id','customer_name','property_id','address','service_type','service_template_id',
    'initial_price','weekly_price','biweekly_price','monthly_price','overgrowth_multiplier','custom_travel_required',
    'show_travel_separately','notes','internal_notes','hours','crew_size','rate','travel_fee','measured_sqft',
    'measurement_snapshot','suggested_price','deposit_type','deposit_value'];
  patch_keys text[]; numeric_keys text[]:=array['initial_price','weekly_price','biweekly_price','monthly_price','overgrowth_multiplier',
    'hours','crew_size','rate','travel_fee','measured_sqft','suggested_price','deposit_value'];
  service_keys text[]:=array['user_id','quote_id','sort_order','service_type','service_template_id','quantity','unit','unit_price','est_minutes','kind'];
  measurement_keys text[]:=array['user_id','property_id','kind','unit','value','shapes','source','confidence','confidence_reason','needs_review','notes','measured_at'];
begin
  if p_owner is null or p_quote is null or (auth.uid() is not null and auth.uid() is distinct from p_owner)
    then return jsonb_build_object('code','not_found'); end if;
  if current_setting('transaction_isolation')<>'read committed' then return jsonb_build_object('code','unsupported_isolation'); end if;
  if not public._pilot_qi_keys(p_plan,array['version','expected_editor_revision','expected_target_revision','expected','identity','parent_patch',
    'options','services','provenance','measurement','client_operation_id','editor_generation'])
    or octet_length(p_plan::text)>16777216 or p_plan->'version'<>'1'::jsonb
    or not public._pilot_qi_uuid(p_plan->'client_operation_id')
    or coalesce(p_plan->>'editor_generation','')!~'^[A-Za-z0-9_-]{1,128}$'
    or coalesce(p_plan->>'expected_editor_revision','')!~'^[a-f0-9]{32}$'
    or coalesce(p_plan->>'expected_target_revision','')!~'^[a-f0-9]{32}$'
    or not public._pilot_qi_keys(p_plan->'expected',array['editor','targets'])
    or not public._pilot_qi_keys(p_plan->'options',array['mode','rows'])
    or jsonb_typeof(p_plan#>'{options,rows}') is distinct from 'array'
    or jsonb_typeof(p_plan->'services') is distinct from 'array'
    then return jsonb_build_object('code','invalid_plan'); end if;
  mode:=p_plan#>>'{provenance,mode}'; patch:=p_plan->'parent_patch'; patch_keys:=base_keys;
  if mode='ensure_current' then
    if not public._pilot_qi_keys(p_plan->'provenance',array['mode','value_grade','nearby_count']) then return jsonb_build_object('code','invalid_plan'); end if;
    patch_keys:=patch_keys||array['value_grade','nearby_count'];
    if patch->'value_grade' is distinct from p_plan#>'{provenance,value_grade}' or patch->'nearby_count' is distinct from p_plan#>'{provenance,nearby_count}'
      then return jsonb_build_object('code','invalid_plan'); end if;
  elsif mode='preserve' then
    if not public._pilot_qi_keys(p_plan->'provenance',array['mode']) then return jsonb_build_object('code','invalid_plan'); end if;
  else return jsonb_build_object('code','invalid_plan'); end if;
  if not public._pilot_qi_keys(patch,patch_keys) then return jsonb_build_object('code','invalid_plan'); end if;
  foreach k in array array['customer_id','property_id','service_template_id'] loop
    if not public._pilot_qi_uuid(patch->k,true) then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  foreach k in array array['customer_name','address','service_type'] loop
    if jsonb_typeof(patch->k) is distinct from 'string' then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  foreach k in array array['notes','internal_notes','deposit_type'] loop
    if jsonb_typeof(patch->k) not in ('string','null') then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  foreach k in array numeric_keys loop
    if jsonb_typeof(patch->k) not in ('number','null') then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  if jsonb_typeof(patch->'custom_travel_required')<>'boolean' or jsonb_typeof(patch->'show_travel_separately')<>'boolean'
    or jsonb_typeof(patch->'measurement_snapshot') not in ('object','null')
    or not public._pilot_qi_uuid(p_plan#>'{identity,resolved,customer_id}',true)
    or not public._pilot_qi_uuid(p_plan#>'{identity,resolved,property_id}',true)
    or patch->'customer_id' is distinct from p_plan#>'{identity,resolved,customer_id}'
    or patch->'property_id' is distinct from p_plan#>'{identity,resolved,property_id}'
    then return jsonb_build_object('code','invalid_plan'); end if;
  target_customer:=(patch->>'customer_id')::uuid; target_property:=(patch->>'property_id')::uuid;
  -- Convert before any DML. Native column types are the authority for storage
  -- precision; the private TypeScript planner remains the sole calculation path.
  select * into pq from jsonb_populate_record(null::public.quotes,patch);
  i:=0;
  for v in select value from jsonb_array_elements(p_plan#>'{options,rows}') loop
    if not public._pilot_qi_keys(v,array['quote_id','user_id','name','description','price','sort_order','is_recommended'])
      or v->>'quote_id' is distinct from p_quote::text or v->>'user_id' is distinct from p_owner::text
      or jsonb_typeof(v->'name') is distinct from 'string' or jsonb_typeof(v->'description') not in ('string','null')
      or jsonb_typeof(v->'price')<>'number' or v->'sort_order' is distinct from to_jsonb(i)
      or jsonb_typeof(v->'is_recommended')<>'boolean' then return jsonb_build_object('code','invalid_plan'); end if;
    select * into opt from jsonb_populate_record(null::public.quote_options,v); i:=i+1;
  end loop;
  i:=0;
  for v in select value from jsonb_array_elements(p_plan->'services') loop
    if not public._pilot_qi_keys(v,case when i=0 then service_keys else service_keys||array['discount_type','discount_value','notes'] end)
      or v->>'quote_id' is distinct from p_quote::text or v->>'user_id' is distinct from p_owner::text
      or v->'sort_order' is distinct from to_jsonb(i) or not public._pilot_qi_uuid(v->'service_template_id',true)
      or jsonb_typeof(v->'service_type') is distinct from 'string' or jsonb_typeof(v->'unit') not in ('string','null')
      or jsonb_typeof(v->'quantity')<>'number' or jsonb_typeof(v->'unit_price')<>'number'
      or jsonb_typeof(v->'est_minutes') not in ('number','null') or v->>'kind' not in ('service','material')
      then return jsonb_build_object('code','invalid_plan'); end if;
    select * into svc from jsonb_populate_record(null::public.quote_services,v); i:=i+1;
  end loop;
  if jsonb_array_length(p_plan#>'{options,rows}')>4 or
    (jsonb_array_length(p_plan#>'{options,rows}')>0 and jsonb_array_length(p_plan->'services')>0)
    then return jsonb_build_object('code','invalid_plan'); end if;
  -- The builder can carry unused blank lines with template IDs. Those dependencies
  -- are additionally bound through its target snapshot and the complete editor.
  for v in select value from jsonb_array_elements(p_plan#>'{expected,targets,templates}') loop
    if not public._pilot_qi_uuid(v#>'{row,id}') then return jsonb_build_object('code','invalid_plan'); end if;
  end loop;
  select coalesce(array_agg((value#>>'{row,id}')::uuid order by value#>>'{row,id}'),'{}'::uuid[]) into template_ids
    from jsonb_array_elements(p_plan#>'{expected,targets,templates}');
  if (pq.service_template_id is not null and not pq.service_template_id=any(template_ids)) or exists(
    select 1 from jsonb_array_elements(p_plan->'services') x where x->>'service_template_id' is not null and not (x->>'service_template_id')::uuid=any(template_ids))
    then return jsonb_build_object('code','invalid_plan'); end if;
  if p_plan->'measurement'<>'null'::jsonb then
    if not public._pilot_qi_keys(p_plan->'measurement',array['payload','prior_lawn_value'])
      or not public._pilot_qi_keys(p_plan#>'{measurement,payload}',measurement_keys) then return jsonb_build_object('code','invalid_plan'); end if;
    m:=p_plan#>'{measurement,payload}';
    if m->>'user_id' is distinct from p_owner::text or m->>'property_id' is distinct from target_property::text
      or target_property is null or m->>'kind'<>'lawn' or m->>'unit'<>'sqft' or m->>'source'<>'manual'
      or m->'shapes'<>'[]'::jsonb or m->>'confidence'<>'high' or m->'needs_review'<>'false'::jsonb
      or not public._pilot_qi_text(m->'confidence_reason') or m->'notes'<>'null'::jsonb
      or jsonb_typeof(m->'value')<>'number' or (m->>'value')::numeric<0
      or not public._pilot_qi_text(m->'measured_at')
      then return jsonb_build_object('code','invalid_plan'); end if;
    select * into meas from jsonb_populate_record(null::public.property_measurements,m);
  end if;

  perform public._pilot_quote_save_lock(p_owner,p_quote,array[target_customer],array[target_property]);
  select * into q from public.quotes where id=p_quote and user_id=p_owner;
  if not found then return jsonb_build_object('code','not_found'); end if;
  s:=public._pilot_qs_snapshot(p_owner,p_quote);
  if s->>'code'<>'snapshot' then return s; end if;
  if s->>'editor_revision' is distinct from p_plan->>'expected_editor_revision'
    or s is distinct from p_plan#>'{expected,editor}' then return jsonb_build_object('code','stale_editor'); end if;
  t:=public.pilot_quote_save_targets(p_owner,p_quote,p_plan->>'expected_editor_revision',p_plan->'identity',template_ids,mode);
  if t->>'code'<>'targets' then return t; end if;
  if t->>'target_revision' is distinct from p_plan->>'expected_target_revision' or t is distinct from p_plan#>'{expected,targets}'
    then return jsonb_build_object('code','stale_targets'); end if;
  if target_customer is distinct from q.customer_id and exists(select 1 from public.pilot_quote_followup_workflows where user_id=p_owner and quote_id=p_quote)
    then return jsonb_build_object('code','retained_customer_binding'); end if;
  if (q.selected_option_id is not null and (p_plan#>>'{options,mode}'<>'preserve' or p_plan#>'{options,rows}'<>'[]'::jsonb or pq.initial_price is distinct from q.initial_price))
    or (q.selected_option_id is null and p_plan#>>'{options,mode}'<>'replace') then return jsonb_build_object('code','invalid_plan'); end if;
  -- The canonical planner compares raw inputs. A negative cadence becomes null
  -- in the parent patch and can legitimately request ensure with equal stored
  -- values. Do not reconstruct that lost browser value with another engine.
  -- Preserve must still never hide a changed outgoing price.
  if mode='preserve' and (coalesce((patch->>'initial_price')::numeric,0)<>coalesce(q.initial_price,0)
    or coalesce((patch->>'weekly_price')::numeric,0)<>coalesce(q.weekly_price,0)
    or coalesce((patch->>'biweekly_price')::numeric,0)<>coalesce(q.biweekly_price,0)
    or coalesce((patch->>'monthly_price')::numeric,0)<>coalesce(q.monthly_price,0)) then return jsonb_build_object('code','invalid_plan'); end if;
  if m is not null and p_plan#>'{measurement,prior_lawn_value}' is distinct from coalesce(t#>'{property,row,lawn_sqft}','null'::jsonb)
    then return jsonb_build_object('code','stale_targets'); end if;
  before_q:=to_jsonb(q); retained:=public._pilot_qs_retained(p_owner,p_quote);
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) into before_events
    from public.property_measurement_events e where e.user_id=p_owner and e.property_id=target_property;

  -- ALL writes below belong to this one RPC transaction. There is deliberately
  -- no exception handler or compensation path. Any later failure rolls back.
  identity_result:=public.pilot_quote_identity_save(p_owner,p_quote,p_plan->'identity');
  if coalesce(identity_result->>'code','') not in ('saved','unchanged') then
    raise exception 'pilot_quote_save_identity_refused' using errcode='P0001'; end if;
  if mode='ensure_current' then
    version_id:=public.ensure_pricing_config_version(p_owner);
    if version_id is null or not exists(select 1 from public.pricing_config_versions where id=version_id and user_id=p_owner)
      then raise exception 'pilot_quote_save_pricing_version_missing' using errcode='P0001'; end if;
  end if;
  update public.quotes set customer_id=pq.customer_id,customer_name=pq.customer_name,property_id=pq.property_id,address=pq.address,
    service_type=pq.service_type,service_template_id=pq.service_template_id,initial_price=pq.initial_price,weekly_price=pq.weekly_price,
    biweekly_price=pq.biweekly_price,monthly_price=pq.monthly_price,overgrowth_multiplier=pq.overgrowth_multiplier,
    custom_travel_required=pq.custom_travel_required,show_travel_separately=pq.show_travel_separately,notes=pq.notes,internal_notes=pq.internal_notes,
    hours=pq.hours,crew_size=pq.crew_size,rate=pq.rate,travel_fee=pq.travel_fee,measured_sqft=pq.measured_sqft,measurement_snapshot=pq.measurement_snapshot,
    suggested_price=pq.suggested_price,deposit_type=pq.deposit_type,deposit_value=pq.deposit_value,
    price_source=case when mode='ensure_current' then 'engine' else quotes.price_source end,
    pricing_config_version_id=case when mode='ensure_current' then version_id else quotes.pricing_config_version_id end,
    value_grade=case when mode='ensure_current' then pq.value_grade else quotes.value_grade end,
    nearby_count=case when mode='ensure_current' then pq.nearby_count else quotes.nearby_count end
    where id=p_quote and user_id=p_owner returning * into q;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'pilot_quote_save_parent_missing' using errcode='P0001'; end if;
  if p_plan#>>'{options,mode}'='replace' then
    with removed as (delete from public.quote_options where user_id=p_owner and quote_id=p_quote returning id)
      select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into deleted_ids from removed;
    select coalesce(jsonb_agg(value#>'{row,id}' order by value#>>'{row,id}'),'[]'::jsonb) into expected_ids from jsonb_array_elements(s->'options');
    if deleted_ids is distinct from expected_ids then raise exception 'pilot_quote_save_option_delete_mismatch' using errcode='P0001'; end if;
    for v in select value from jsonb_array_elements(p_plan#>'{options,rows}') loop
      select * into opt from jsonb_populate_record(null::public.quote_options,v);
      insert into public.quote_options(user_id,quote_id,name,description,price,sort_order,is_recommended)
        values(p_owner,p_quote,opt.name,opt.description,opt.price,opt.sort_order,opt.is_recommended) returning * into opt;
      if public._pilot_qs_pick(to_jsonb(opt),array['quote_id','user_id','name','description','price','sort_order','is_recommended'])
        is distinct from public._pilot_qs_pick(to_jsonb(jsonb_populate_record(null::public.quote_options,v)),array['quote_id','user_id','name','description','price','sort_order','is_recommended'])
        then raise exception 'pilot_quote_save_option_insert_mismatch' using errcode='P0001'; end if;
      opt_rows:=opt_rows||jsonb_build_array(to_jsonb(opt));
    end loop;
  end if;
  with removed as (delete from public.quote_services where user_id=p_owner and quote_id=p_quote returning id)
    select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into deleted_ids from removed;
  select coalesce(jsonb_agg(value#>'{row,id}' order by value#>>'{row,id}'),'[]'::jsonb) into expected_ids from jsonb_array_elements(s->'services');
  if deleted_ids is distinct from expected_ids then raise exception 'pilot_quote_save_service_delete_mismatch' using errcode='P0001'; end if;
  for v in select value from jsonb_array_elements(p_plan->'services') loop
    select * into svc from jsonb_populate_record(null::public.quote_services,v);
    insert into public.quote_services(user_id,quote_id,service_type,service_template_id,quantity,unit,unit_price,est_minutes,discount_type,discount_value,notes,sort_order,kind)
      values(p_owner,p_quote,svc.service_type,svc.service_template_id,svc.quantity,svc.unit,svc.unit_price,svc.est_minutes,svc.discount_type,svc.discount_value,svc.notes,svc.sort_order,svc.kind) returning * into svc;
    if (to_jsonb(svc)-array['id','created_at']) is distinct from public._pilot_qs_pick(to_jsonb(jsonb_populate_record(null::public.quote_services,v)),service_keys||array['discount_type','discount_value','notes'])
      then raise exception 'pilot_quote_save_service_insert_mismatch' using errcode='P0001'; end if;
    service_rows:=service_rows||jsonb_build_array(to_jsonb(svc));
  end loop;
  if m is not null then
    expected_event:=t->'lawn'='null'::jsonb
      or public._pilot_qs_pick(t#>'{lawn,row}',array['value','source','shapes'])
        is distinct from public._pilot_qs_pick(to_jsonb(meas),array['value','source','shapes']);
    insert into public.property_measurements(user_id,property_id,kind,unit,value,shapes,source,confidence,confidence_reason,needs_review,notes,measured_at)
      values(p_owner,target_property,meas.kind,meas.unit,meas.value,meas.shapes,meas.source,meas.confidence,meas.confidence_reason,meas.needs_review,meas.notes,meas.measured_at)
      on conflict(property_id,kind) do update set unit=excluded.unit,value=excluded.value,shapes=excluded.shapes,source=excluded.source,
        confidence=excluded.confidence,confidence_reason=excluded.confidence_reason,needs_review=excluded.needs_review,notes=excluded.notes,measured_at=excluded.measured_at
      returning * into meas;
    if public._pilot_qs_pick(to_jsonb(meas),measurement_keys) is distinct from public._pilot_qs_pick(to_jsonb(jsonb_populate_record(null::public.property_measurements,m)),measurement_keys)
      or not exists(select 1 from public.properties where id=target_property and user_id=p_owner and lawn_sqft=meas.value)
      then raise exception 'pilot_quote_save_measurement_mismatch' using errcode='P0001'; end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) into after_events
    from public.property_measurement_events e where e.user_id=p_owner and e.property_id=target_property;
  if not (after_events @> before_events) or jsonb_array_length(after_events)<>jsonb_array_length(before_events)+(case when coalesce(expected_event,false) then 1 else 0 end)
    then raise exception 'pilot_quote_save_measurement_history_mismatch' using errcode='P0001'; end if;
  if coalesce(expected_event,false) and not exists(select 1 from jsonb_array_elements(after_events) e
    where not before_events @> jsonb_build_array(e) and e->>'measurement_id'=meas.id::text and e->>'action'='measured'
      and public._pilot_qs_pick(e,array['user_id','property_id','kind','unit','value','shapes','source','confidence','confidence_reason','measured_at'])
        =public._pilot_qs_pick(to_jsonb(meas),array['user_id','property_id','kind','unit','value','shapes','source','confidence','confidence_reason','measured_at']))
    then raise exception 'pilot_quote_save_measurement_history_payload' using errcode='P0001'; end if;
  after_s:=public._pilot_qs_snapshot(p_owner,p_quote);
  if after_s->>'code'<>'snapshot' then raise exception 'pilot_quote_save_receipt_unavailable' using errcode='P0001'; end if;
  if public._pilot_qs_pick(after_s#>'{quote,row}',patch_keys) is distinct from public._pilot_qs_pick(to_jsonb(pq),patch_keys)
    or ((after_s#>'{quote,row}')-(base_keys||array['updated_at','man_hours','subtotal','total','price_source','pricing_config_version_id','value_grade','nearby_count']))
      is distinct from (before_q-(base_keys||array['updated_at','man_hours','subtotal','total','price_source','pricing_config_version_id','value_grade','nearby_count']))
    or after_s->'addons' is distinct from s->'addons' or after_s#>'{acceptance,latest}' is distinct from s#>'{acceptance,latest}'
    or public._pilot_qs_retained(p_owner,p_quote) is distinct from retained
    then raise exception 'pilot_quote_save_protected_state_changed' using errcode='P0001'; end if;
  if mode='preserve' and public._pilot_qs_pick(after_s#>'{quote,row}',array['price_source','pricing_config_version_id','value_grade','nearby_count'])
    is distinct from public._pilot_qs_pick(before_q,array['price_source','pricing_config_version_id','value_grade','nearby_count'])
    then raise exception 'pilot_quote_save_provenance_changed' using errcode='P0001'; end if;
  if mode='ensure_current' and (after_s#>>'{quote,row,price_source}'<>'engine' or after_s#>>'{quote,row,pricing_config_version_id}' is distinct from version_id::text)
    then raise exception 'pilot_quote_save_provenance_missing' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(value->'row' order by (value#>>'{row,sort_order}')::int,value#>>'{row,id}'),'[]'::jsonb) into got from jsonb_array_elements(after_s->'services');
  if got is distinct from service_rows then raise exception 'pilot_quote_save_services_receipt_mismatch' using errcode='P0001'; end if;
  if p_plan#>>'{options,mode}'='preserve' then
    if after_s->'options' is distinct from s->'options' then raise exception 'pilot_quote_save_settled_options_changed' using errcode='P0001'; end if;
  else
    select coalesce(jsonb_agg(value->'row' order by (value#>>'{row,sort_order}')::int,value#>>'{row,id}'),'[]'::jsonb) into got from jsonb_array_elements(after_s->'options');
    if got is distinct from opt_rows then raise exception 'pilot_quote_save_options_receipt_mismatch' using errcode='P0001'; end if;
  end if;
  receipt:=jsonb_build_object('code','committed','quote_id',p_quote,'owner_id',p_owner,
    'client_operation_id',p_plan->'client_operation_id','editor_generation',p_plan->'editor_generation',
    'before_revision',p_plan->'expected_editor_revision','after_revision',after_s->'editor_revision',
    'quote',public._pilot_qs_editor_quote(after_s#>'{quote,row}'),
    'options',(select coalesce(jsonb_agg(value->'row' order by (value#>>'{row,sort_order}')::int,value#>>'{row,id}'),'[]'::jsonb) from jsonb_array_elements(after_s->'options')),
    'services',service_rows,'measurement',case when m is null then null else to_jsonb(meas) end,
    'acceptance_current',after_s#>'{acceptance,current}','identity',identity_result);
  if octet_length(receipt::text)>16777216 then raise exception 'pilot_quote_save_receipt_too_large' using errcode='P0001'; end if;
  return receipt;
end $$;

revoke all on function public._pilot_qs_pick(jsonb,text[]) from public,anon,authenticated,service_role;
revoke all on function public._pilot_quote_save_lock(uuid,uuid,uuid[],uuid[]) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_pricing(uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_editor(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_snapshot(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_targets(uuid,uuid,text,jsonb,uuid[]) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_editor_quote(jsonb) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qs_retained(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_save_snapshot(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_save_targets(uuid,uuid,text,jsonb,uuid[],text) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_save(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pilot_quote_save_snapshot(uuid,uuid) to service_role;
grant execute on function public.pilot_quote_save_targets(uuid,uuid,text,jsonb,uuid[],text) to service_role;
grant execute on function public.pilot_quote_save(uuid,uuid,jsonb) to service_role;

commit;
