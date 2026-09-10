-- DORMANT: requires pilot-quote-save.sql and its shared lock helper first.
-- Not a migration or mounted endpoint. Only the marked cloud proof may load it.
-- Canonical acceptance pricing, terms classification and ledger remain native.
begin;

create function public.quote_choice_amount(p_base numeric,p_travel numeric,p_addons numeric)
returns numeric language sql immutable set search_path='' as $$
  select coalesce(p_base,0)+coalesce(p_travel,0)+coalesce(p_addons,0);
$$;

-- Fail closed if the captured native definitions changed. Patch only the shared
-- amount expressions and immediate UPDATE row count, not a second choice engine.
do $patch$
declare src text; definition text; anchor text;
begin
  select prosrc,pg_get_functiondef(oid) into src,definition from pg_proc
    where oid='public.quote_apply_choice(uuid,uuid,uuid[],text)'::regprocedure;
  if md5(src) is distinct from '7f265dc75045d96945e262ba9045f8e8' then
    raise exception 'quote_apply_choice definition changed; review required'; end if;
  anchor := 'accepted_price = coalesce(v_base, 0) + v_travel + v_addons,';
  if length(src)-length(replace(src,anchor,''))<>length(anchor) then raise exception 'choice amount anchor mismatch'; end if;
  definition := replace(definition,anchor,'accepted_price = public.quote_choice_amount(v_base, v_travel, v_addons),');
  anchor := 'v_free boolean;';
  if length(src)-length(replace(src,anchor,''))<>length(anchor) then raise exception 'choice declaration anchor mismatch'; end if;
  definition := replace(definition,anchor,anchor||E'\n  v_quote_rows bigint;');
  anchor := 'where id = p_quote_id and status in (''draft'', ''sent'');';
  if length(src)-length(replace(src,anchor,''))<>length(anchor) then raise exception 'choice UPDATE anchor mismatch'; end if;
  definition := replace(definition,anchor,anchor||E'\n  GET DIAGNOSTICS v_quote_rows = ROW_COUNT;');
  anchor := 'return found;';
  if length(src)-length(replace(src,anchor,''))<>length(anchor) then raise exception 'choice return anchor mismatch'; end if;
  definition := replace(definition,anchor,'return v_quote_rows = 1;');
  execute definition;

  select prosrc,pg_get_functiondef(oid) into src,definition from pg_proc
    where oid='public.quote_record_acceptance(uuid,text,text,uuid,text,text,text,boolean)'::regprocedure;
  if md5(src) is distinct from '3fa928af90c6e3fd7c098ddafdeddb04' then
    raise exception 'quote_record_acceptance definition changed; review required'; end if;
  anchor := E'v_amount := coalesce(v_opt.price, v_q.initial_price, 0)\n              + coalesce(v_q.travel_fee, 0) + v_addon_total;';
  if length(src)-length(replace(src,anchor,''))<>length(anchor) then raise exception 'ledger amount anchor mismatch'; end if;
  execute replace(definition,anchor,
    'v_amount := public.quote_choice_amount(coalesce(v_opt.price, v_q.initial_price, 0), v_q.travel_fee, v_addon_total);');
end $patch$;

-- Internal authority resolver. Raw bearer tokens never enter returned JSON.
-- The initial read selects lock targets only; every binding is checked again
-- after the shared owner/customer/property/quote/children/settings locks.
create function public._pilot_qva_authority(p_owner uuid,p_portal_token text,p_quote uuid)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare q public.quotes; t public.customer_portal_tokens; c public.customers;
  v_owner uuid; v_customer uuid; v_token_fence text;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    return jsonb_build_object('code','unsupported_isolation'); end if;
  if p_quote is null or (p_owner is null)=(p_portal_token is null)
     or (p_portal_token is not null and (p_portal_token='' or octet_length(p_portal_token)>10000)) then
    return jsonb_build_object('code','invalid_request'); end if;
  if p_owner is not null then
    if auth.uid() is not null and auth.uid() is distinct from p_owner then
      return jsonb_build_object('code','not_found'); end if;
    v_owner:=p_owner;
  else
    select * into t from public.customer_portal_tokens where token=p_portal_token and not revoked;
    if not found then return jsonb_build_object('code','not_found'); end if;
    v_owner:=t.user_id; v_customer:=t.customer_id;
    v_token_fence:=md5(to_jsonb(t)::text);
  end if;
  select * into q from public.quotes where id=p_quote and user_id=v_owner;
  if not found or (p_portal_token is not null and q.customer_id is distinct from v_customer) then
    return jsonb_build_object('code','not_found'); end if;
  -- Implemented by the separately owned dormant full Save proposal.
  perform public._pilot_quote_save_lock(v_owner,p_quote,
    array_remove(array[q.customer_id],null),array_remove(array[q.property_id],null));
  if p_portal_token is not null then
    select * into t from public.customer_portal_tokens where token=p_portal_token for update;
    if not found or t.revoked or t.user_id is distinct from v_owner
      or t.customer_id is distinct from v_customer or md5(to_jsonb(t)::text) is distinct from v_token_fence then
      return jsonb_build_object('code','not_found'); end if;
  end if;
  select * into q from public.quotes where id=p_quote and user_id=v_owner;
  if not found or (p_portal_token is not null and q.customer_id is distinct from v_customer) then
    return jsonb_build_object('code','not_found'); end if;
  if q.customer_id is not null then
    select * into c from public.customers where id=q.customer_id and user_id=v_owner;
    if not found then return jsonb_build_object('code','not_found'); end if;
  elsif p_portal_token is not null then return jsonb_build_object('code','not_found'); end if;
  return jsonb_build_object('code','authorized','owner_id',v_owner,'customer_id',q.customer_id,
    'actor_id',case when p_owner is null then q.customer_id else v_owner end,
    'actor_customer_name',c.name,'token_fence',v_token_fence,'portal',p_owner is null);
end $$;

-- Entire confirmation is produced while the same read/write row locks are held.
-- It is not a cache, a standing engine, or a disclosure of private bookkeeping.
create function public._pilot_qva_expected(p_authority jsonb,p_quote uuid,p_option uuid)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare q public.quotes; b public.business_settings; a public.quote_acceptances;
  v_owner uuid := (p_authority->>'owner_id')::uuid; v_options jsonb; v_services jsonb;
  v_addons jsonb; v_ids jsonb; v_base numeric(10,2); v_travel numeric(10,2);
  v_addon_total numeric(10,2); v_amount numeric(10,2); v_public jsonb; v_private jsonb;
  v_offered jsonb; v_expected jsonb; v_free boolean; v_settings_exists boolean;
begin
  select * into q from public.quotes where id=p_quote and user_id=v_owner;
  if not found then return null; end if;
  select * into b from public.business_settings where user_id=v_owner;
  v_settings_exists:=found;
  select * into a from public.quote_acceptances where quote_id=p_quote and user_id=v_owner order by seq desc limit 1;
  if exists(select 1 from public.quote_options where quote_id=p_quote and user_id<>v_owner)
    or exists(select 1 from public.quote_services where quote_id=p_quote and user_id<>v_owner)
    or exists(select 1 from public.quote_addons where quote_id=p_quote and user_id<>v_owner) then
    raise exception 'quote acceptance child ownership mismatch' using errcode='23514'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'description',o.description,
    'price',o.price,'sort_order',o.sort_order,'is_recommended',o.is_recommended) order by o.sort_order,o.id),'[]'::jsonb)
    into v_options from public.quote_options o where o.quote_id=p_quote and o.user_id=v_owner;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'service_type',s.service_type,'quantity',s.quantity,
    'unit',s.unit,'unit_price',s.unit_price,'est_minutes',s.est_minutes,'discount_type',s.discount_type,
    'discount_value',s.discount_value,'notes',s.notes,'kind',s.kind,'sort_order',s.sort_order) order by s.sort_order,s.id),'[]'::jsonb)
    into v_services from public.quote_services s where s.quote_id=p_quote and s.user_id=v_owner;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'price',x.price,
    'is_selected',x.is_selected,'sort_order',x.sort_order) order by x.sort_order,x.id),'[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(x.id) order by x.id) filter(where x.is_selected),'[]'::jsonb),
    coalesce(sum(x.price) filter(where x.is_selected),0)
    into v_addons,v_ids,v_addon_total from public.quote_addons x where x.quote_id=p_quote and x.user_id=v_owner;
  v_base:=q.initial_price; v_travel:=coalesce(q.travel_fee,0);
  if p_option is not null then
    select price into v_base from public.quote_options where id=p_option and quote_id=p_quote and user_id=v_owner;
    if not found then return null; end if;
  elsif jsonb_array_length(v_options)>0 then return null; end if;
  v_amount:=public.quote_choice_amount(v_base,v_travel,v_addon_total);
  v_free:=q.no_charge_at is not null and q.no_charge_reason is not null and q.no_charge_by is not null;
  v_public:=jsonb_build_object('quote_id',q.id,'customer_name',q.customer_name,'quote_number',q.quote_number,
    'address',q.address,'service_type',q.service_type,'notes',q.notes,'status',q.status,'valid_until',q.valid_until,
    'initial_price',q.initial_price,'travel_fee',q.travel_fee,'addons_total',q.addons_total,'total',q.total,
    'weekly_price',q.weekly_price,'biweekly_price',q.biweekly_price,'monthly_price',q.monthly_price,
    'deposit_type',q.deposit_type,'deposit_value',q.deposit_value,'selected_option_id',q.selected_option_id,
    'options',v_options,'services',v_services,'addons',v_addons,'included_addon_ids',v_ids,
    'offered_option_id',p_option,'accepted_amount',v_amount,'terms_text',b.terms_text,
    'gst_percent',b.gst_percent,'company_name',b.company_name,'no_charge',v_free);
  v_private:=jsonb_build_object('owner_id',q.user_id,'quote_id',q.id,'customer_id',q.customer_id,
    'property_id',q.property_id,'actor_id',p_authority->'actor_id','actor_customer_name',p_authority->'actor_customer_name',
    'portal',p_authority->'portal','token_fence',p_authority->'token_fence','sent_at',q.sent_at,
    'no_charge_at',q.no_charge_at,'no_charge_reason',q.no_charge_reason,'no_charge_by',q.no_charge_by,
    'material_fingerprint',public.quote_material_fingerprint(p_quote),'terms_fingerprint',public.quote_terms_fingerprint(v_owner),
    'settings_exists',v_settings_exists,'owner_name',b.owner_name,'company_name',b.company_name,
    'terms_payment_claim',b.terms_payment_claim,'terms_payment_claim_fingerprint',b.terms_payment_claim_fingerprint,
    'terms_payment_claim_version',b.terms_payment_claim_version,'prior_acceptance_id',a.id,'prior_acceptance_seq',a.seq,
    'acceptance_current',public.quote_acceptance_is_current(p_quote),
    'addon_provenance',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'selected_via',x.selected_via,
      'selected_at',x.selected_at) order by x.id),'[]'::jsonb) from public.quote_addons x where x.quote_id=p_quote and x.user_id=v_owner));
  v_offered:=jsonb_build_object('public',v_public,'authorityFence',md5(v_private::text));
  v_expected:=jsonb_build_object('version',1,'quoteId',p_quote,'previewRevision',md5(v_offered::text),
    'priorAcceptanceId',a.id,'priorAcceptanceSeq',a.seq,'offered',v_offered);
  if octet_length(v_expected::text)>16777216 then raise exception 'acceptance preview exceeds transport bound' using errcode='54000'; end if;
  return v_expected;
end $$;

create function public._pilot_qva_expected_valid(p_expected jsonb,p_quote uuid) returns boolean
language plpgsql immutable set search_path='' as $$
declare p jsonb; x jsonb; k text;
begin
  if p_expected is null or octet_length(p_expected::text)>16777216
    or not public._pilot_qi_keys(p_expected,array['version','quoteId','previewRevision','priorAcceptanceId','priorAcceptanceSeq','offered'])
    or p_expected->'version' is distinct from '1'::jsonb or p_expected->>'quoteId' is distinct from p_quote::text
    or not public._pilot_qi_uuid(p_expected->'priorAcceptanceId',true)
    or not coalesce(((p_expected->'priorAcceptanceId'='null'::jsonb and p_expected->'priorAcceptanceSeq'='null'::jsonb)
      or (p_expected->'priorAcceptanceId'<>'null'::jsonb and jsonb_typeof(p_expected->'priorAcceptanceSeq')='number'
        and (p_expected->>'priorAcceptanceSeq') ~ '^[1-9][0-9]*$')),false)
    or not public._pilot_qi_keys(p_expected->'offered',array['public','authorityFence'])
    or coalesce(p_expected#>>'{offered,authorityFence}','') !~ '^[0-9a-f]{32}$'
    or coalesce(p_expected->>'previewRevision','') !~ '^[0-9a-f]{32}$' then return false; end if;
  -- The revision is opaque server output. JSON transport changes 100.00 to 100:
  -- equal jsonb numeric values can have different ::text bytes and MD5 hashes.
  -- Commit still compares the ENTIRE expected value (including this revision
  -- and the private authority fence) against a fresh native projection under
  -- the shared locks. Rehashing client serialization would reject valid previews.
  p:=p_expected#>'{offered,public}';
  if not public._pilot_qi_keys(p,array['quote_id','customer_name','quote_number','address','service_type','notes','status','valid_until',
    'initial_price','travel_fee','addons_total','total','weekly_price','biweekly_price','monthly_price','deposit_type','deposit_value',
    'selected_option_id','options','services','addons','included_addon_ids','offered_option_id','accepted_amount','terms_text','gst_percent','company_name','no_charge'])
    or p->>'quote_id' is distinct from p_quote::text then return false; end if;
  foreach k in array array['customer_name','quote_number','address','service_type','notes','status','valid_until','deposit_type','terms_text','company_name'] loop
    if jsonb_typeof(p->k) not in ('string','null') then return false; end if;
  end loop;
  foreach k in array array['initial_price','travel_fee','addons_total','total','weekly_price','biweekly_price','monthly_price','deposit_value','accepted_amount','gst_percent'] loop
    if jsonb_typeof(p->k) not in ('number','null') then return false; end if;
  end loop;
  if not public._pilot_qi_uuid(p->'selected_option_id',true) or not public._pilot_qi_uuid(p->'offered_option_id',true)
    or jsonb_typeof(p->'no_charge')<>'boolean' then return false; end if;
  foreach k in array array['options','services','addons','included_addon_ids'] loop
    if jsonb_typeof(p->k)<>'array' then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(p->'options') loop
    if not public._pilot_qi_keys(x,array['id','name','description','price','sort_order','is_recommended'])
      or not public._pilot_qi_uuid(x->'id') or jsonb_typeof(x->'name')<>'string'
      or jsonb_typeof(x->'description') not in ('string','null') or jsonb_typeof(x->'price')<>'number'
      or jsonb_typeof(x->'sort_order')<>'number' or jsonb_typeof(x->'is_recommended')<>'boolean' then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(p->'services') loop
    if not public._pilot_qi_keys(x,array['id','service_type','quantity','unit','unit_price','est_minutes','discount_type','discount_value','notes','kind','sort_order'])
      or not public._pilot_qi_uuid(x->'id') then return false; end if;
    foreach k in array array['service_type','unit','discount_type','notes','kind'] loop
      if jsonb_typeof(x->k) not in ('string','null') then return false; end if;
    end loop;
    foreach k in array array['quantity','unit_price','est_minutes','discount_value','sort_order'] loop
      if jsonb_typeof(x->k) not in ('number','null') then return false; end if;
    end loop;
  end loop;
  for x in select value from jsonb_array_elements(p->'addons') loop
    if not public._pilot_qi_keys(x,array['id','name','price','is_selected','sort_order'])
      or not public._pilot_qi_uuid(x->'id') or jsonb_typeof(x->'name')<>'string'
      or jsonb_typeof(x->'price')<>'number' or jsonb_typeof(x->'sort_order')<>'number'
      or jsonb_typeof(x->'is_selected')<>'boolean' then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(p->'included_addon_ids') loop
    if not public._pilot_qi_uuid(x) then return false; end if;
  end loop;
  -- Nested types/values must also equal the complete fresh native projection at
  -- commit. Shape validity alone never authorizes a write.
  return true;
end $$;

create function public.pilot_quote_acceptance_preview(p_owner uuid,p_portal_token text,p_quote uuid,p_option uuid)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare authority jsonb; expected jsonb; v_status text;
begin
  authority:=public._pilot_qva_authority(p_owner,p_portal_token,p_quote);
  if authority->>'code'<>'authorized' then return authority; end if;
  select status into v_status from public.quotes where id=p_quote and user_id=(authority->>'owner_id')::uuid;
  if (p_owner is null and v_status is distinct from 'sent') or (p_owner is not null and v_status not in ('draft','sent')) then
    return jsonb_build_object('code','not_eligible'); end if;
  expected:=public._pilot_qva_expected(authority,p_quote,p_option);
  if expected is null then return jsonb_build_object('code','invalid_choice'); end if;
  return jsonb_build_object('code','preview','expected',expected);
end $$;

create function public.pilot_quote_acceptance_commit(p_owner uuid,p_portal_token text,p_quote uuid,
  p_expected jsonb,p_option uuid,p_addons uuid[],p_reason text,p_note text,p_terms_ack boolean)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare authority jsonb; expected jsonb; a public.quote_acceptances; v_owner uuid; v_actor uuid;
  v_id uuid; v_kind text; v_source text; v_label text; v_status text; v_ids uuid[]; v_receipt jsonb;
begin
  if not public._pilot_qva_expected_valid(p_expected,p_quote) or p_addons is null or p_terms_ack is null
    or (p_owner is null and (p_reason is not null or p_note is not null))
    or (p_owner is not null and nullif(btrim(p_reason),'') is null)
    or octet_length(coalesce(p_reason,'')||coalesce(p_note,''))>200000 then
    return jsonb_build_object('code','invalid_request'); end if;
  -- Explicitly valid empty set differs from missing, duplicates or null IDs.
  select coalesce(array_agg(distinct x order by x),'{}'::uuid[]) into v_ids from unnest(p_addons) x where x is not null;
  if cardinality(v_ids)<>cardinality(p_addons) or to_jsonb(v_ids) is distinct from p_expected#>'{offered,public,included_addon_ids}'
    or to_jsonb(p_option) is distinct from nullif(p_expected#>'{offered,public,offered_option_id}','null'::jsonb) then
    return jsonb_build_object('code','invalid_choice'); end if;
  authority:=public._pilot_qva_authority(p_owner,p_portal_token,p_quote);
  if authority->>'code'<>'authorized' then return authority; end if;
  v_owner:=(authority->>'owner_id')::uuid; v_actor:=(authority->>'actor_id')::uuid;
  expected:=public._pilot_qva_expected(authority,p_quote,p_option);
  if expected is distinct from p_expected then return jsonb_build_object('code','quote_changed'); end if;
  select status into v_status from public.quotes where id=p_quote and user_id=v_owner;
  if (p_owner is null and v_status is distinct from 'sent') or (p_owner is not null and v_status not in ('draft','sent')) then
    return jsonb_build_object('code','not_eligible'); end if;
  if not public.quote_apply_choice(p_quote,p_option,v_ids,case when p_owner is null then 'portal' else 'owner' end) then
    -- The native core may have touched add-ons before a refusal. Never return
    -- an ordinary refusal after this call: a raised error rolls back everything.
    raise exception 'quote acceptance choice refused' using errcode='23514'; end if;
  if p_owner is null then v_kind:='customer'; v_source:='portal'; v_label:=authority->>'actor_customer_name';
  else
    v_kind:='owner_on_behalf'; v_source:='dashboard';
    select coalesce(nullif(btrim(owner_name),''),nullif(btrim(company_name),'')) into v_label
      from public.business_settings where user_id=v_owner;
  end if;
  v_id:=public.quote_record_acceptance(p_quote,v_kind,v_source,v_actor,v_label,p_reason,p_note,
    case when p_owner is null then p_terms_ack else true end);
  if v_id is null then raise exception 'quote acceptance ledger missing' using errcode='23514'; end if;
  select * into a from public.quote_acceptances where id=v_id and user_id=v_owner and quote_id=p_quote;
  if not found or a.kind is distinct from v_kind or a.source is distinct from v_source
    or a.actor_id is distinct from v_actor or a.customer_id is distinct from (authority->>'customer_id')::uuid
    or a.selected_option_id is distinct from (select selected_option_id from public.quotes where id=p_quote and user_id=v_owner)
    or a.accepted_amount is distinct from (expected#>>'{offered,public,accepted_amount}')::numeric
    or a.supersedes_id is distinct from (expected->>'priorAcceptanceId')::uuid
    or a.seq is distinct from coalesce((expected->>'priorAcceptanceSeq')::integer,0)+1
    or (select count(*) from public.quote_acceptances where quote_id=p_quote and user_id=v_owner
      and seq>coalesce((expected->>'priorAcceptanceSeq')::integer,0))<>1
    or not public.quote_acceptance_is_current(p_quote) then
    raise exception 'quote acceptance ledger binding mismatch' using errcode='23514'; end if;
  if (select coalesce(jsonb_agg(to_jsonb(id) order by id),'[]'::jsonb) from public.quote_addons
    where quote_id=p_quote and user_id=v_owner and is_selected) is distinct from to_jsonb(v_ids) then
    raise exception 'quote acceptance selected set mismatch' using errcode='23514'; end if;
  v_receipt:=jsonb_build_object('code','accepted','quote_id',p_quote,'acceptance_id',a.id,'acceptance_seq',a.seq,
    'kind',a.kind,'source',a.source,'actor_id',a.actor_id,'customer_id',a.customer_id,
    'accepted_amount',a.accepted_amount,'selected_option_id',a.selected_option_id,'addon_ids',v_ids,
    'document_fingerprint',a.document_fingerprint,'terms_fingerprint',a.terms_fingerprint,'previous_acceptance_id',a.supersedes_id);
  if octet_length(v_receipt::text)>16777216 then raise exception 'acceptance receipt exceeds transport bound' using errcode='54000'; end if;
  return v_receipt;
end $$;

create function public.pilot_quote_acceptance_reconcile(p_owner uuid,p_portal_token text,p_quote uuid,
  p_expected jsonb,p_option uuid,p_addons uuid[],p_reason text,p_note text)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare authority jsonb; current_expected jsonb;
begin
  if not public._pilot_qva_expected_valid(p_expected,p_quote) or p_addons is null
    or (p_owner is null and (p_reason is not null or p_note is not null)) then
    return jsonb_build_object('code','invalid_request'); end if;
  authority:=public._pilot_qva_authority(p_owner,p_portal_token,p_quote);
  if authority->>'code'<>'authorized' then return jsonb_build_object('code','unknown'); end if;
  current_expected:=public._pilot_qva_expected(authority,p_quote,p_option);
  -- Conservative by reviewed scope: the native ledger does not retain every
  -- private preview dependency or its pre-choice fingerprint/standing. The full
  -- fence includes those dependencies and changes on a ledger transition. Do
  -- not drop them, fabricate a preimage, infer request attribution from status,
  -- or retry a write. Even a matching current document does not prove this
  -- dispatch committed; retain client recovery for explicit review.
  if current_expected is distinct from p_expected then return jsonb_build_object('code','unknown'); end if;
  return jsonb_build_object('code','unknown');
end $$;

-- Same signatures and compatibility grants, but no unversioned acceptance door.
-- Installed only in the dormant candidate phase AFTER baseline reproduction.
create or replace function public.portal_accept_quote(p_token text,p_quote_id uuid,p_option_id uuid default null,
  p_addon_ids uuid[] default null,p_terms_ack boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$ begin
  raise exception 'quote_acceptance_refresh_required' using errcode='P0001'; end $$;
create or replace function public.owner_record_customer_acceptance(p_quote_id uuid,p_reason text,p_option_id uuid default null,
  p_addon_ids uuid[] default null,p_note text default null) returns uuid
language plpgsql security definer set search_path='' as $$ begin
  raise exception 'quote_acceptance_refresh_required' using errcode='P0001'; end $$;
create or replace function public.owner_select_quote_option(p_quote_id uuid,p_option_id uuid default null,
  p_addon_ids uuid[] default null,p_reason text default null,p_note text default null) returns boolean
language plpgsql security definer set search_path='' as $$ begin
  raise exception 'quote_acceptance_refresh_required' using errcode='P0001'; end $$;

revoke all on function public.quote_choice_amount(numeric,numeric,numeric) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qva_authority(uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qva_expected(jsonb,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public._pilot_qva_expected_valid(jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_acceptance_preview(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_acceptance_commit(uuid,text,uuid,jsonb,uuid,uuid[],text,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.pilot_quote_acceptance_reconcile(uuid,text,uuid,jsonb,uuid,uuid[],text,text) from public,anon,authenticated,service_role;
grant execute on function public.pilot_quote_acceptance_preview(uuid,text,uuid,uuid) to service_role;
grant execute on function public.pilot_quote_acceptance_commit(uuid,text,uuid,jsonb,uuid,uuid[],text,text,boolean) to service_role;
grant execute on function public.pilot_quote_acceptance_reconcile(uuid,text,uuid,jsonb,uuid,uuid[],text,text) to service_role;
commit;
