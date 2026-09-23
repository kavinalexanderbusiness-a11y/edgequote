-- Owner-authorized, server-measured automatic mowing quotes.
-- Nothing in this migration enables auto pricing. A version exists only after an
-- authenticated owner saves every rule and explicitly selects an immutable price card.

create table if not exists public.auto_mowing_quote_rule_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  is_active boolean not null default true,
  enabled boolean not null,
  permitted_cadences text[] not null,
  accepted_measurement_confidences text[] not null,
  accepted_measurement_sources text[] not null,
  maximum_measurement_age_minutes integer not null check (maximum_measurement_age_minutes between 1 and 10080),
  route_mode text not null check (route_mode in ('approved_neighborhoods', 'distance_and_density')),
  approved_neighborhoods text[] not null default '{}',
  maximum_base_distance_km numeric,
  minimum_nearby_jobs integer,
  minimum_charge numeric not null check (minimum_charge > 0),
  minimum_margin_percent numeric not null check (minimum_margin_percent >= 0 and minimum_margin_percent < 100),
  full_cost_basis_confirmed boolean not null,
  materials_cost_per_visit numeric not null check (materials_cost_per_visit >= 0),
  equipment_cost_per_visit numeric not null check (equipment_cost_per_visit >= 0),
  delivery_disposal_cost_per_visit numeric not null check (delivery_disposal_cost_per_visit >= 0),
  contingency_percent numeric not null check (contingency_percent >= 0 and contingency_percent <= 100),
  pricing_config_version_id uuid not null references public.pricing_config_versions(id),
  duration_crew_bands jsonb not null,
  deposit_type text not null check (deposit_type in ('none', 'percent', 'fixed')),
  deposit_value numeric,
  quote_valid_days integer not null check (quote_valid_days between 1 and 90),
  unique (user_id, version),
  check (cardinality(permitted_cadences) > 0 and permitted_cadences <@ array['one_time','weekly','biweekly']::text[]),
  check (cardinality(accepted_measurement_confidences) > 0 and accepted_measurement_confidences <@ array['high','medium','low']::text[]),
  check (cardinality(accepted_measurement_sources) > 0),
  check ((route_mode = 'approved_neighborhoods' and cardinality(approved_neighborhoods) > 0)
      or (route_mode = 'distance_and_density' and maximum_base_distance_km is not null
          and maximum_base_distance_km > 0 and minimum_nearby_jobs is not null and minimum_nearby_jobs >= 0)),
  check ((deposit_type = 'none' and deposit_value is null)
      or (deposit_type = 'percent' and deposit_value > 0 and deposit_value <= 100)
      or (deposit_type = 'fixed' and deposit_value > 0))
);

create unique index if not exists auto_mowing_quote_one_active_per_owner
  on public.auto_mowing_quote_rule_versions(user_id) where is_active;
create unique index if not exists quotes_auto_mowing_idempotency_unique
  on public.quotes(user_id, (lead_meta->>'auto_mowing_idempotency_key'))
  where lead_meta->>'auto_mowing_idempotency_key' is not null;

alter table public.auto_mowing_quote_rule_versions enable row level security;
drop policy if exists "auto mowing rules: select own" on public.auto_mowing_quote_rule_versions;
create policy "auto mowing rules: select own" on public.auto_mowing_quote_rule_versions
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.auto_mowing_rule_versions_guard()
returns trigger language plpgsql set search_path = 'public', 'pg_temp' as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'automatic mowing rule versions are append-only';
  end if;
  if old.is_active and not new.is_active
     and (to_jsonb(new) - 'is_active') = (to_jsonb(old) - 'is_active') then
    return new;
  end if;
  raise exception 'automatic mowing rule versions are immutable';
end;
$function$;

drop trigger if exists auto_mowing_rule_versions_immutable on public.auto_mowing_quote_rule_versions;
create trigger auto_mowing_rule_versions_immutable before update or delete
  on public.auto_mowing_quote_rule_versions for each row execute function public.auto_mowing_rule_versions_guard();

create or replace function public.save_auto_mowing_quote_rules(p_rules jsonb)
returns jsonb language plpgsql security definer set search_path = 'public', 'pg_temp' as $function$
declare
  v_user uuid := auth.uid();
  v_id uuid; v_version integer; v_pricing uuid; v_route text; v_deposit text;
  v_bands jsonb; v_cadences text[]; v_conf text[]; v_sources text[]; v_hoods text[];
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(p_rules) <> 'object' then raise exception 'invalid rules'; end if;

  begin v_pricing := (p_rules->>'pricing_config_version_id')::uuid;
  exception when others then raise exception 'select a valid pricing configuration version'; end;
  if not exists (select 1 from public.pricing_config_versions p
    where p.id = v_pricing and p.user_id = v_user and p.source = 'recorded') then
    raise exception 'select a recorded pricing configuration version owned by this business';
  end if;

  v_route := p_rules->>'route_mode';
  v_deposit := p_rules->>'deposit_type';
  v_bands := p_rules->'duration_crew_bands';
  if jsonb_typeof(v_bands) <> 'array' or jsonb_array_length(v_bands) = 0
     or exists (select 1 from jsonb_array_elements(v_bands) b
       where not (b ? 'minutes') or not (b ? 'crew_size')
         or (b->>'minutes')::numeric <= 0 or (b->>'crew_size')::integer < 1
         or ((b ? 'maximum_sqft') and jsonb_typeof(b->'maximum_sqft') <> 'null' and (b->>'maximum_sqft')::numeric <= 0)) then
    raise exception 'save valid duration and crew bands';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_bands) b where not (b ? 'maximum_sqft') or jsonb_typeof(b->'maximum_sqft') = 'null') then
    raise exception 'duration and crew bands need a final open-ended band';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_cadences from jsonb_array_elements_text(p_rules->'permitted_cadences') x;
  select coalesce(array_agg(distinct x), '{}') into v_conf from jsonb_array_elements_text(p_rules->'accepted_measurement_confidences') x;
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_sources from jsonb_array_elements_text(p_rules->'accepted_measurement_sources') x where btrim(x) <> '';
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_hoods from jsonb_array_elements_text(coalesce(p_rules->'approved_neighborhoods','[]'::jsonb)) x where btrim(x) <> '';
  if cardinality(v_cadences) = 0 or not v_cadences <@ array['one_time','weekly','biweekly']::text[] then raise exception 'invalid permitted cadences'; end if;
  if cardinality(v_conf) = 0 or not v_conf <@ array['high','medium','low']::text[] then raise exception 'invalid measurement confidences'; end if;
  if cardinality(v_sources) = 0 then raise exception 'save at least one server measurement source'; end if;
  if v_route not in ('approved_neighborhoods','distance_and_density') then raise exception 'invalid route policy'; end if;
  if v_route = 'approved_neighborhoods' and cardinality(v_hoods) = 0 then raise exception 'save at least one approved neighbourhood'; end if;
  if v_route = 'distance_and_density' and (nullif(p_rules->>'maximum_base_distance_km','')::numeric <= 0
      or nullif(p_rules->>'minimum_nearby_jobs','')::integer < 0) then raise exception 'save route distance and density limits'; end if;
  if v_deposit not in ('none','percent','fixed') then raise exception 'invalid deposit rule'; end if;
  if v_deposit = 'none' and p_rules->'deposit_value' <> 'null'::jsonb then raise exception 'clear the deposit value'; end if;
  if v_deposit = 'percent' and (nullif(p_rules->>'deposit_value','')::numeric <= 0 or (p_rules->>'deposit_value')::numeric > 100) then raise exception 'invalid deposit percentage'; end if;
  if v_deposit = 'fixed' and nullif(p_rules->>'deposit_value','')::numeric <= 0 then raise exception 'invalid fixed deposit'; end if;
  if coalesce((p_rules->>'full_cost_basis_confirmed')::boolean, false) is not true then raise exception 'confirm the full cost basis before enabling automatic quotes'; end if;
  if not (p_rules ?& array['materials_cost_per_visit','equipment_cost_per_visit','delivery_disposal_cost_per_visit','contingency_percent','minimum_margin_percent']) then
    raise exception 'save every cost and margin input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|auto-mowing-rules', 0));
  select coalesce(max(version),0) + 1 into v_version from public.auto_mowing_quote_rule_versions where user_id = v_user;
  update public.auto_mowing_quote_rule_versions set is_active = false where user_id = v_user and is_active;

  -- A new commercial rule version invalidates only still-awaiting auto quotes.
  -- Accepted/scheduled/completed/paid records are immutable business history.
  update public.quotes q set
    valid_until = current_date - 1,
    lead_meta = coalesce(q.lead_meta,'{}'::jsonb) || jsonb_build_object('auto_rules_superseded_at', now())
  where q.user_id = v_user and q.status = 'sent'
    and q.lead_meta->>'auto_mowing_rules_version_id' is not null;

  insert into public.auto_mowing_quote_rule_versions (
    user_id, version, created_by, enabled, permitted_cadences,
    accepted_measurement_confidences, accepted_measurement_sources, maximum_measurement_age_minutes,
    route_mode, approved_neighborhoods, maximum_base_distance_km, minimum_nearby_jobs,
    minimum_charge, minimum_margin_percent, full_cost_basis_confirmed,
    materials_cost_per_visit, equipment_cost_per_visit, delivery_disposal_cost_per_visit, contingency_percent,
    pricing_config_version_id, duration_crew_bands, deposit_type, deposit_value, quote_valid_days
  ) values (
    v_user, v_version, v_user, (p_rules->>'enabled')::boolean, v_cadences,
    v_conf, v_sources, (p_rules->>'maximum_measurement_age_minutes')::integer,
    v_route, v_hoods, nullif(p_rules->>'maximum_base_distance_km','')::numeric,
    nullif(p_rules->>'minimum_nearby_jobs','')::integer,
    (p_rules->>'minimum_charge')::numeric, (p_rules->>'minimum_margin_percent')::numeric,
    (p_rules->>'full_cost_basis_confirmed')::boolean,
    (p_rules->>'materials_cost_per_visit')::numeric, (p_rules->>'equipment_cost_per_visit')::numeric,
    (p_rules->>'delivery_disposal_cost_per_visit')::numeric, (p_rules->>'contingency_percent')::numeric,
    v_pricing, v_bands, v_deposit, nullif(p_rules->>'deposit_value','')::numeric,
    (p_rules->>'quote_valid_days')::integer
  ) returning id into v_id;
  return jsonb_build_object('state','saved','id',v_id,'version',v_version);
end;
$function$;

create or replace function public.issue_auto_mowing_quote(
  p_token text, p_customer_id uuid, p_lead_id uuid, p_rules_version_id uuid,
  p_decision jsonb, p_measurement jsonb, p_route jsonb
)
returns jsonb language plpgsql security definer set search_path = 'public', 'pg_temp' as $function$
declare
  v_user uuid; v_rule public.auto_mowing_quote_rule_versions; v_lead public.website_leads;
  v_customer public.customers; v_quote uuid; v_qnum text; v_num integer; v_property uuid;
  v_key text; v_job numeric; v_travel numeric; v_total numeric; v_hours numeric; v_crew integer;
  v_econ jsonb; v_cadence text; v_deposit_type text; v_deposit numeric;
begin
  select b.user_id into v_user from public.business_settings b
   where b.booking_token = p_token and b.booking_enabled = true;
  if v_user is null then return jsonb_build_object('state','review_required','reason','invalid_site'); end if;
  if not exists (
    select 1 from public.service_templates s
     where s.user_id = v_user and s.is_active and s.published_at is not null
       and lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) in
         ('lawn mowing', 'lawn mowing & edging', 'lawn mowing and edging')
  ) then
    return jsonb_build_object('state','review_required','reason','service_not_published');
  end if;
  select * into v_rule from public.auto_mowing_quote_rule_versions r
   where r.id = p_rules_version_id and r.user_id = v_user and r.is_active and r.enabled;
  if not found then return jsonb_build_object('state','review_required','reason','rules_changed'); end if;
  select * into v_lead from public.website_leads l
   where l.id = p_lead_id and l.user_id = v_user and l.customer_id = p_customer_id for update;
  if not found then return jsonb_build_object('state','review_required','reason','lead_tenant_mismatch'); end if;
  select * into v_customer from public.customers c where c.id = p_customer_id and c.user_id = v_user;
  if not found then return jsonb_build_object('state','review_required','reason','customer_tenant_mismatch'); end if;

  v_key := p_decision->>'idempotencyKey'; v_job := (p_decision->>'jobPrice')::numeric;
  v_travel := (p_decision->>'travelFee')::numeric; v_total := (p_decision->>'total')::numeric;
  v_hours := (p_decision->>'hours')::numeric; v_crew := (p_decision->>'crewSize')::integer;
  v_cadence := p_decision->>'cadence'; v_econ := p_decision->'economics';
  v_deposit_type := p_decision->>'depositType'; v_deposit := nullif(p_decision->>'depositValue','')::numeric;
  if v_key !~ '^[0-9a-f]{64}$' or v_job <= 0 or v_travel < 0 or v_total <> v_job + v_travel
     or v_hours <= 0 or v_crew < 1 or v_cadence <> all(v_rule.permitted_cadences)
     or p_decision->>'pricingConfigVersionId' <> v_rule.pricing_config_version_id::text
     or (p_decision->>'rulesVersion')::integer <> v_rule.version
     or jsonb_typeof(v_econ) <> 'object'
     or (v_econ->>'totalCost')::numeric < 0
     or (v_econ->>'profit')::numeric <> round(v_total - (v_econ->>'totalCost')::numeric, 1)
     or (v_econ->>'marginPercent')::numeric < v_rule.minimum_margin_percent then
    return jsonb_build_object('state','review_required','reason','decision_invalid');
  end if;
  if p_measurement->>'verified_by' <> 'hmac_city_measurement_attestation'
     or p_measurement->>'customer_confirmation' <> 'looks_right'
     or coalesce(p_measurement->>'polygon_hash','') !~ '^[0-9a-f]{64}$'
     or (p_measurement->>'sqft')::numeric <= 0
     or jsonb_typeof(p_measurement->'polygon') <> 'array'
     or (p_measurement->>'lat')::double precision not between 50.6 and 51.4
     or (p_measurement->>'lng')::double precision not between -114.6 and -113.6
     or p_measurement->>'source' <> all(v_rule.accepted_measurement_sources)
     or p_measurement->>'confidence' <> all(v_rule.accepted_measurement_confidences) then
    return jsonb_build_object('state','review_required','reason','measurement_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|auto-mowing|' || v_key, 0));
  select q.id, q.quote_number into v_quote, v_qnum from public.quotes q
   where q.user_id = v_user and q.customer_id = p_customer_id
     and q.lead_meta->>'auto_mowing_idempotency_key' = v_key limit 1;
  if v_quote is not null then
    update public.website_leads
       set quote_id = v_quote,
           status = case when status = 'new' then 'quoted' else status end
     where id = p_lead_id and user_id = v_user and customer_id = p_customer_id
       and (quote_id is distinct from v_quote or status = 'new');
    return jsonb_build_object('state','quoted','quote_id',v_quote,'quote_number',v_qnum,'replayed',true);
  end if;

  select p.id into v_property from public.properties p
   where p.user_id = v_user and p.customer_id = p_customer_id
     and lower(regexp_replace(btrim(p.address), '\s+', ' ', 'g'))
       = lower(regexp_replace(btrim(v_lead.address), '\s+', ' ', 'g'))
   order by p.is_primary desc nulls last, p.created_at asc limit 1;
  if v_property is null then
    return jsonb_build_object('state','review_required','reason','property_address_not_reconciled');
  end if;

  -- The property row was created/reconciled by the durable lead intake. Update
  -- only that exact customer/address after the HMAC envelope and polygon hash
  -- have passed; historical and unrelated properties remain untouched.
  update public.properties p set
    lawn_sqft = (p_measurement->>'sqft')::numeric,
    lat = (p_measurement->>'lat')::double precision,
    lng = (p_measurement->>'lng')::double precision,
    lawn_polygon = p_measurement->'polygon',
    measurement_history = coalesce(p.measurement_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'date', p_measurement->>'measured_at',
      'total_sqft', (p_measurement->>'sqft')::numeric,
      'sections', p_measurement->'polygon',
      'source', p_measurement->>'source',
      'confidence', p_measurement->>'confidence',
      'attestation_polygon_hash', p_measurement->>'polygon_hash'))
   where p.id = v_property and p.user_id = v_user and p.customer_id = p_customer_id;
  if not found then return jsonb_build_object('state','review_required','reason','property_update_failed'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|quote-number', 0));
  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
   from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  insert into public.quotes (
    user_id, quote_number, customer_id, customer_name, address, service_type, notes,
    hours, crew_size, rate, travel_fee, status, issued_date, initial_price,
    weekly_price, biweekly_price,
    sent_at, valid_until, measured_sqft, pricing_confidence, property_id,
    selected_cadence, pricing_config_version_id, nearby_count, price_source,
    deposit_type, deposit_value, measurement_snapshot, lead_meta, internal_notes
  ) values (
    v_user, v_qnum, p_customer_id, left(v_customer.name,200), left(v_lead.address,300),
    'Lawn Mowing & Edging',
    'Mow, trim and edge the server-measured lawn. Price shown is per visit for the selected cadence.',
    v_hours, v_crew, round(v_job / nullif(v_hours * v_crew,0),2), v_travel, 'sent', current_date, v_job,
    case when v_cadence = 'weekly' then v_total else null end,
    case when v_cadence = 'biweekly' then v_total else null end,
    now(), current_date + v_rule.quote_valid_days, (p_measurement->>'sqft')::numeric,
    p_measurement->>'confidence', v_property, v_cadence, v_rule.pricing_config_version_id,
    (p_route->>'nearby_jobs')::integer, 'engine',
    case when v_deposit_type = 'none' then null else v_deposit_type end,
    case when v_deposit_type = 'none' then null else v_deposit end,
    p_measurement || jsonb_build_object('route',p_route,'rules_version_id',v_rule.id,'pricing_config_version_id',v_rule.pricing_config_version_id),
    jsonb_build_object(
      'website_lead_id',p_lead_id,'auto_mowing_quote',true,
      'auto_mowing_idempotency_key',v_key,'auto_mowing_rules_version_id',v_rule.id,
      'auto_mowing_rules_version',v_rule.version,'economics',v_econ,
      'route_eligibility','approved','route_eligibility_approved_at',now(),
      'scheduling_inputs_confirmed_at',now(),
      'recurrence_setup_required',v_cadence in ('weekly','biweekly')),
    'Automatic quote economics: ' || v_econ::text
  ) returning id into v_quote;

  update public.website_leads
     set quote_id = v_quote, status = 'quoted'
   where id = p_lead_id and user_id = v_user and customer_id = p_customer_id;

  insert into public.service_requests(user_id,customer_id,message)
  values (v_user,p_customer_id,'Automatic mowing quote ' || v_qnum || ' issued at $' || trim(to_char(v_total,'FM999999990D00')) || ' per visit.');
  return jsonb_build_object('state','quoted','quote_id',v_quote,'quote_number',v_qnum,'replayed',false);
end;
$function$;

revoke all on table public.auto_mowing_quote_rule_versions from public, anon, authenticated, service_role;
grant select on table public.auto_mowing_quote_rule_versions to authenticated;
grant all on table public.auto_mowing_quote_rule_versions to service_role;
revoke all on function public.save_auto_mowing_quote_rules(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_auto_mowing_quote_rules(jsonb) to authenticated;
revoke all on function public.issue_auto_mowing_quote(text,uuid,uuid,uuid,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.issue_auto_mowing_quote(text,uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;

create or replace function public.record_auto_mowing_review_reasons(
  p_token text, p_lead_id uuid, p_quote_id uuid, p_missing jsonb
)
returns boolean language plpgsql security definer set search_path = 'public', 'pg_temp' as $function$
declare v_user uuid;
begin
  select b.user_id into v_user from public.business_settings b
   where b.booking_token = p_token and b.booking_enabled = true;
  if v_user is null or jsonb_typeof(p_missing) <> 'array'
     or jsonb_array_length(p_missing) > 30 or length(p_missing::text) > 12000 then return false; end if;
  update public.quotes q set
    lead_meta = coalesce(q.lead_meta, '{}'::jsonb) || jsonb_build_object('auto_mowing_review_reasons', p_missing),
    internal_notes = concat_ws(E'\n', nullif(q.internal_notes,''), 'Automatic mowing review required: ' || p_missing::text)
   where q.id = p_quote_id and q.user_id = v_user
     and q.lead_meta->>'website_lead_id' = p_lead_id::text;
  return found;
end;
$function$;

revoke all on function public.record_auto_mowing_review_reasons(text,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_auto_mowing_review_reasons(text,uuid,uuid,jsonb) to service_role;

comment on table public.auto_mowing_quote_rule_versions is
  'Append-only owner authorization for mowing-only automatic quotes. No row means review required.';
