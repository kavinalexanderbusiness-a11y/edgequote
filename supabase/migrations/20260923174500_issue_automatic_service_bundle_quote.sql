-- Atomic writer for server-decided automatic multi-service estimates.
--
-- This migration enables no pricing. It accepts only active immutable owner
-- versions, recomputes the bundle discount from the saved rule, writes the
-- quote and every line in one transaction, and never creates a job, booking,
-- payment, invoice or card record.

create unique index if not exists quotes_auto_service_bundle_idempotency_unique
  on public.quotes(user_id, (lead_meta->>'automatic_bundle_idempotency_key'))
  where lead_meta->>'automatic_bundle_idempotency_key' is not null;

create or replace function public.issue_automatic_service_bundle_quote(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid,
  p_decision jsonb,
  p_measurement jsonb,
  p_route_by_service jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid;
  v_lead public.website_leads;
  v_customer public.customers;
  v_property uuid;
  v_quote uuid;
  v_qnum text;
  v_num integer;
  v_lines jsonb;
  v_line jsonb;
  v_line_decision jsonb;
  v_pricing public.automatic_service_pricing_versions;
  v_bundle public.automatic_bundle_pricing_versions;
  v_service_template uuid;
  v_service text;
  v_label text;
  v_cadence text;
  v_line_price numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_total numeric := 0;
  v_expected_discount numeric := 0;
  v_total_cost numeric := 0;
  v_margin numeric;
  v_line_discount numeric := 0;
  v_allocated_discount numeric := 0;
  v_line_number integer := 0;
  v_key text;
  v_bundle_id uuid;
  v_measurement_sqft numeric;
  v_route jsonb;
begin
  select b.user_id into v_user
    from public.business_settings b
   where b.booking_token = p_token and b.booking_enabled = true;
  if v_user is null then
    return jsonb_build_object('state','review_required','reason','invalid_site');
  end if;
  if jsonb_typeof(p_decision) <> 'object'
     or p_decision->>'state' <> 'priced'
     or p_decision->>'estimateStatus' <> 'written_estimate'
     or jsonb_typeof(p_decision->'lines') <> 'array'
     or jsonb_array_length(p_decision->'lines') not between 1 and 12
     or jsonb_typeof(p_measurement) <> 'object'
     or jsonb_typeof(p_route_by_service) <> 'object' then
    return jsonb_build_object('state','review_required','reason','decision_invalid');
  end if;

  select * into v_lead from public.website_leads l
   where l.id = p_lead_id and l.user_id = v_user and l.customer_id = p_customer_id
   for update;
  if not found then return jsonb_build_object('state','review_required','reason','lead_tenant_mismatch'); end if;
  select * into v_customer from public.customers c
   where c.id = p_customer_id and c.user_id = v_user;
  if not found then return jsonb_build_object('state','review_required','reason','customer_tenant_mismatch'); end if;

  begin
    v_measurement_sqft := (p_measurement->>'sqft')::numeric;
  exception when others then
    return jsonb_build_object('state','review_required','reason','measurement_invalid');
  end;
  if p_measurement->>'verified_by' <> 'hmac_city_measurement_attestation'
     or p_measurement->>'customer_confirmation' not in ('automatic_applied','looks_right')
     or coalesce(p_measurement->>'polygon_hash','') !~ '^[0-9a-f]{64}$'
     or v_measurement_sqft <= 0
     or jsonb_typeof(p_measurement->'polygon') <> 'array'
     or (p_measurement->>'lat')::double precision not between 50.6 and 51.4
     or (p_measurement->>'lng')::double precision not between -114.6 and -113.6 then
    return jsonb_build_object('state','review_required','reason','measurement_invalid');
  end if;

  v_lines := p_decision->'lines';
  for v_line in select value from jsonb_array_elements(v_lines)
  loop
    v_line_number := v_line_number + 1;
    v_service := lower(btrim(coalesce(v_line->>'serviceKey','')));
    v_label := btrim(coalesce(v_line->>'label',''));
    v_cadence := lower(btrim(coalesce(v_line->>'cadence','')));
    v_line_decision := v_line->'decision';
    begin
      v_line_price := (v_line->>'price')::numeric;
      select * into v_pricing from public.automatic_service_pricing_versions p
       where p.id = (v_line_decision->>'pricingVersionId')::uuid
         and p.user_id = v_user and p.is_active and p.enabled
       for share;
    exception when others then
      return jsonb_build_object('state','review_required','reason','pricing_version_invalid');
    end;
    if not found
       or v_line->>'state' <> 'priced'
       or jsonb_typeof(v_line_decision) <> 'object'
       or v_line_decision->>'state' <> 'priced'
       or v_service <> v_pricing.service_key
       or v_line_decision->>'serviceKey' <> v_service
       or v_line_decision->>'cadence' <> v_cadence
       or v_cadence not in ('one_time','weekly','biweekly','monthly','seasonal')
       or (v_line_decision->>'pricingVersion')::integer <> v_pricing.version
       or v_line_decision->>'pricingEngineVersion' <> v_pricing.engine_version
       or v_line_decision->>'routeRuleVersion' <> v_pricing.route_rule_version
       or coalesce(v_line_decision->>'idempotencyKey','') !~ '^[0-9a-f]{64}$'
       or v_line_price <= 0
       or v_line_price <> (v_line_decision->>'price')::numeric
       or v_label = '' or length(v_label) > 100 then
      return jsonb_build_object('state','review_required','reason','priced_line_invalid');
    end if;
    if jsonb_typeof(v_line_decision->'economics') <> 'object'
       or (v_line_decision->'economics'->>'totalCost')::numeric < 0
       or (v_line_decision->'economics'->>'profit')::numeric <> round(v_line_price - (v_line_decision->'economics'->>'totalCost')::numeric, 2)
       or (v_line_decision->'economics'->>'marginPercent')::numeric < (v_pricing.rules->>'minimum_margin_percent')::numeric then
      return jsonb_build_object('state','review_required','reason','line_economics_invalid');
    end if;
    v_route := p_route_by_service->v_service;
    if jsonb_typeof(v_route) <> 'object'
       or coalesce((v_route->>'verified_by_server')::boolean,false) is not true
       or coalesce(v_route->>'provider','') <> 'google_places'
       or btrim(coalesce(v_route->>'place_id','')) = ''
       or coalesce(v_route->>'route_rule_version','') <> v_pricing.route_rule_version
       or nullif(v_route->>'base_distance_km','') is null
       or nullif(v_route->>'base_distance_km','')::numeric < 0
       or nullif(v_route->>'route_travel_km','') is null
       or nullif(v_route->>'route_travel_km','')::numeric < 0
       or nullif(v_route->>'nearby_jobs','') is null
       or nullif(v_route->>'nearby_jobs','')::integer < 0 then
      return jsonb_build_object('state','review_required','reason','route_evidence_invalid');
    end if;
    if v_service in ('mowing','snow') and nullif(v_route->>'eligible_route_days','')::integer < 1 then
      return jsonb_build_object('state','review_required','reason','route_capacity_unavailable');
    end if;
    if not exists (
      select 1 from public.service_templates s
       where s.user_id = v_user and s.is_active and s.published_at is not null
         and lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) = any(case v_service
           when 'mowing' then array['lawn mowing','lawn mowing & edging','lawn mowing and edging']
           when 'fertilization' then array['lawn fertilization','fertilization']
           when 'overseeding' then array['grass seeding & overseeding','overseeding']
           when 'topsoil' then array['topsoil application','topsoil']
           when 'weed_treatment' then array['weed treatment','spot weed treatment']
           when 'snow' then array['snow removal & ice management','snow removal']
           else array[''] end)
    ) then return jsonb_build_object('state','review_required','reason','service_not_published'); end if;
    v_subtotal := round(v_subtotal + v_line_price, 2);
    v_total_cost := round(v_total_cost + (v_line_decision->'economics'->>'totalCost')::numeric, 2);
  end loop;

  begin
    v_discount := (p_decision->>'discount')::numeric;
    v_total := (p_decision->>'bundlePrice')::numeric;
  exception when others then
    return jsonb_build_object('state','review_required','reason','bundle_total_invalid');
  end;
  if v_subtotal <> (p_decision->>'subtotal')::numeric
     or v_discount < 0 or v_total <= 0 or v_total <> round(v_subtotal - v_discount,2) then
    return jsonb_build_object('state','review_required','reason','bundle_total_invalid');
  end if;

  if jsonb_array_length(v_lines) > 1 then
    begin v_bundle_id := (p_decision->>'bundlePricingVersionId')::uuid;
    exception when others then return jsonb_build_object('state','review_required','reason','bundle_rules_missing'); end;
    select * into v_bundle from public.automatic_bundle_pricing_versions b
     where b.id = v_bundle_id and b.user_id = v_user and b.is_active and b.enabled
       and b.version = (p_decision->>'bundlePricingVersion')::integer
     for share;
    if not found or v_bundle.engine_version = ''
       or jsonb_array_length(v_lines) < (v_bundle.rules->>'minimum_services')::integer then
      return jsonb_build_object('state','review_required','reason','bundle_rules_changed');
    end if;
    v_expected_discount := case v_bundle.rules->>'discount_kind'
      when 'percentage' then round(v_subtotal * (v_bundle.rules->>'discount_value')::numeric / 100, 2)
      when 'fixed' then (v_bundle.rules->>'discount_value')::numeric
      else 0 end;
    v_expected_discount := least(v_expected_discount, (v_bundle.rules->>'maximum_discount')::numeric, v_subtotal - 0.01);
    v_margin := round((v_total - v_total_cost) / v_total * 100, 1);
    if v_discount <> v_expected_discount
       or v_margin < (v_bundle.rules->>'minimum_margin_percent')::numeric then
      return jsonb_build_object('state','review_required','reason','bundle_economics_invalid');
    end if;
  elsif v_discount <> 0 or nullif(p_decision->>'bundlePricingVersionId','') is not null then
    return jsonb_build_object('state','review_required','reason','single_line_bundle_invalid');
  end if;

  v_key := encode(extensions.digest(convert_to((p_decision - 'createdAt')::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|automatic-service-bundle|' || v_key, 0));
  select q.id,q.quote_number into v_quote,v_qnum from public.quotes q
   where q.user_id = v_user and q.customer_id = p_customer_id
     and q.lead_meta->>'automatic_bundle_idempotency_key' = v_key limit 1;
  if v_quote is not null then
    update public.website_leads set quote_id=v_quote,status=case when status='new' then 'quoted' else status end
     where id=p_lead_id and user_id=v_user and customer_id=p_customer_id;
    return jsonb_build_object('state','quoted','quote_id',v_quote,'quote_number',v_qnum,'replayed',true);
  end if;

  select p.id into v_property from public.properties p
   where p.user_id=v_user and p.customer_id=p_customer_id
     and lower(regexp_replace(btrim(p.address), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(v_lead.address), '\s+', ' ', 'g'))
   order by p.is_primary desc nulls last,p.created_at asc limit 1;
  if v_property is null then return jsonb_build_object('state','review_required','reason','property_address_not_reconciled'); end if;

  update public.properties p set
    lawn_sqft=v_measurement_sqft,
    lat=(p_measurement->>'lat')::double precision,
    lng=(p_measurement->>'lng')::double precision,
    lawn_polygon=p_measurement->'polygon',
    google_place_id=coalesce(nullif((p_route_by_service->(v_lines->0->>'serviceKey'))->>'place_id',''),google_place_id),
    measurement_history=coalesce(p.measurement_history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'date',p_measurement->>'measured_at','total_sqft',v_measurement_sqft,'sections',p_measurement->'polygon',
      'source',p_measurement->>'source','confidence',p_measurement->>'confidence',
      'attestation_polygon_hash',p_measurement->>'polygon_hash'))
   where p.id=v_property and p.user_id=v_user and p.customer_id=p_customer_id;
  if not found then return jsonb_build_object('state','review_required','reason','property_update_failed'); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|quote-number',0));
  select coalesce(max((regexp_match(quote_number,'([0-9]+)$'))[1]::int),0)+1 into v_num
    from public.quotes where user_id=v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text,4,'0');

  insert into public.quotes (
    user_id,quote_number,customer_id,customer_name,address,service_type,notes,
    hours,crew_size,rate,travel_fee,status,issued_date,initial_price,sent_at,
    measured_sqft,pricing_confidence,property_id,price_source,measurement_snapshot,lead_meta,internal_notes
  ) values (
    v_user,v_qnum,p_customer_id,left(v_customer.name,200),left(v_lead.address,300),
    case when jsonb_array_length(v_lines)=1 then left(v_lines->0->>'label',200) else 'Multiple Services' end,
    'Server-measured written estimate. Each selected service is itemized below. No booking or payment has been created.',
    1,1,v_total,0,'sent',current_date,v_total,now(),v_measurement_sqft,p_measurement->>'confidence',
    v_property,'engine',p_measurement || jsonb_build_object('route_by_service',p_route_by_service),
    jsonb_build_object(
      'website_lead_id',p_lead_id,'automatic_service_bundle',true,
      'automatic_bundle_idempotency_key',v_key,'automatic_estimate_status','written_estimate',
      'automatic_bundle_pricing_version_id',v_bundle_id,'automatic_bundle_subtotal',v_subtotal,
      'automatic_bundle_discount',v_discount,'booking_status','not_booked'),
    'Automatic service decision: ' || p_decision::text
  ) returning id into v_quote;

  v_line_number := 0;
  v_allocated_discount := 0;
  for v_line in select value from jsonb_array_elements(v_lines)
  loop
    v_line_number := v_line_number + 1;
    v_service := v_line->>'serviceKey';
    v_line_price := (v_line->>'price')::numeric;
    v_line_discount := case
      when v_discount <= 0 then 0
      when v_line_number = jsonb_array_length(v_lines) then round(v_discount - v_allocated_discount,2)
      else round(v_discount * v_line_price / v_subtotal,2)
    end;
    v_allocated_discount := round(v_allocated_discount + v_line_discount,2);
    select s.id into v_service_template from public.service_templates s
     where s.user_id=v_user and s.is_active and s.published_at is not null
       and lower(regexp_replace(btrim(s.name),'\s+',' ','g')) = any(case v_service
         when 'mowing' then array['lawn mowing','lawn mowing & edging','lawn mowing and edging']
         when 'fertilization' then array['lawn fertilization','fertilization']
         when 'overseeding' then array['grass seeding & overseeding','overseeding']
         when 'topsoil' then array['topsoil application','topsoil']
         when 'weed_treatment' then array['weed treatment','spot weed treatment']
         when 'snow' then array['snow removal & ice management','snow removal'] else array[''] end)
     order by s.sort_order nulls last,s.created_at asc limit 1;
    insert into public.quote_services (
      user_id,quote_id,service_type,service_template_id,quantity,unit,unit_price,
      discount_type,discount_value,notes,sort_order,kind
    ) values (
      v_user,v_quote,left(v_line->>'label',200),v_service_template,1,'each',(v_line->>'price')::numeric,
      case when v_line_discount>0 then 'amount' else null end,
      case when v_line_discount>0 then v_line_discount else null end,
      'Automatic written estimate; cadence: ' || (v_line->>'cadence'),v_line_number,'service'
    );
  end loop;

  update public.website_leads set quote_id=v_quote,status='quoted'
   where id=p_lead_id and user_id=v_user and customer_id=p_customer_id;
  insert into public.service_requests(user_id,customer_id,message)
  values (v_user,p_customer_id,'Automatic multi-service written estimate ' || v_qnum || ' issued at $' || trim(to_char(v_total,'FM999999990D00')) || '. No booking or payment was created.');
  return jsonb_build_object('state','quoted','quote_id',v_quote,'quote_number',v_qnum,'replayed',false);
end;
$function$;

revoke all on function public.issue_automatic_service_bundle_quote(text,uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_automatic_service_bundle_quote(text,uuid,uuid,jsonb,jsonb,jsonb)
  to service_role;

comment on function public.issue_automatic_service_bundle_quote(text,uuid,uuid,jsonb,jsonb,jsonb) is
  'Atomically writes a server-priced multi-service quote and itemized lines. Creates no booking, job, invoice, payment or card record.';
