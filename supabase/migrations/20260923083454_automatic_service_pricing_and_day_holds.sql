-- Evidence-backed automatic service estimates and tentative day-only holds.
--
-- This migration intentionally creates no pricing version and enables nothing.
-- An authenticated owner must save a complete immutable version after reviewing
-- the historical cost evidence. Browser values never become prices, jobs or
-- payments through these objects.

create table if not exists public.automatic_service_pricing_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service_key text not null check (service_key in (
    'mowing','fertilization','overseeding','topsoil','weed_treatment','snow')),
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null,
  is_active boolean not null default true,
  enabled boolean not null default false,
  engine_version text not null check (length(btrim(engine_version)) between 1 and 80),
  route_rule_version text not null check (length(btrim(route_rule_version)) between 1 and 80),
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  rules_hash text not null check (rules_hash ~ '^[0-9a-f]{64}$'),
  unique (user_id, service_key, version)
);

alter table public.automatic_service_pricing_versions
  add constraint automatic_service_pricing_versions_user_id_id_key unique (user_id, id);

create unique index if not exists automatic_service_pricing_one_active
  on public.automatic_service_pricing_versions(user_id, service_key) where is_active;

alter table public.automatic_service_pricing_versions enable row level security;
drop policy if exists "automatic service pricing: select own" on public.automatic_service_pricing_versions;
create policy "automatic service pricing: select own" on public.automatic_service_pricing_versions
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.automatic_service_pricing_versions_guard()
returns trigger language plpgsql set search_path = 'public', 'pg_temp' as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'automatic service pricing versions are append-only';
  end if;
  if old.is_active and not new.is_active
     and (to_jsonb(new) - 'is_active') = (to_jsonb(old) - 'is_active') then
    return new;
  end if;
  raise exception 'automatic service pricing versions are immutable';
end;
$function$;

drop trigger if exists automatic_service_pricing_versions_immutable
  on public.automatic_service_pricing_versions;
create trigger automatic_service_pricing_versions_immutable before update or delete
  on public.automatic_service_pricing_versions for each row
  execute function public.automatic_service_pricing_versions_guard();

create or replace function public.save_automatic_service_pricing_version(
  p_service_key text,
  p_rules jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_service text := lower(btrim(coalesce(p_service_key, '')));
  v_version integer;
  v_id uuid;
  v_engine text;
  v_route_version text;
  v_cadences text[];
  v_confidences text[];
  v_sources text[];
  v_base_prices jsonb;
  v_bands jsonb;
  v_materials jsonb;
  v_hash text;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if v_service not in ('mowing','fertilization','overseeding','topsoil','weed_treatment','snow') then
    raise exception 'unsupported automatic service';
  end if;
  if jsonb_typeof(p_rules) <> 'object' then raise exception 'invalid pricing rules'; end if;
  if not p_rules ?& array[
    'enabled','engine_version','route_rule_version','permitted_cadences',
    'accepted_measurement_confidences','accepted_measurement_sources','maximum_measurement_age_minutes',
    'base_prices','base_lawn_sqft','additional_price_per_1000_sqft','additional_area_price',
    'duration_crew_bands','loaded_labour_cost_per_hour','materials','materials_cost_basis_confirmed',
    'equipment_cost_per_visit','delivery_cost_per_visit','disposal_cost_per_visit','overhead_cost_per_visit',
    'contingency_percent','vehicle_cost_per_km','included_route_km','route_price_per_additional_km',
    'minimum_nearby_jobs_for_base','isolated_stop_premium','maximum_automatic_distance_km',
    'maximum_route_premium','maximum_automatic_price','payment_fee_percent','payment_fee_fixed',
    'minimum_margin_percent','price_rounding_increment','full_cost_basis_confirmed'
  ] then raise exception 'complete every pricing, route and cost input'; end if;

  v_engine := btrim(coalesce(p_rules->>'engine_version',''));
  v_route_version := btrim(coalesce(p_rules->>'route_rule_version',''));
  if length(v_engine) not between 1 and 80 or length(v_route_version) not between 1 and 80 then
    raise exception 'save pricing and route rule versions';
  end if;
  if coalesce((p_rules->>'full_cost_basis_confirmed')::boolean, false) is not true then
    raise exception 'confirm labour, materials, travel, equipment, delivery, disposal, fees, overhead and contingency';
  end if;

  if jsonb_typeof(p_rules->'permitted_cadences') <> 'array'
     or jsonb_typeof(p_rules->'accepted_measurement_confidences') <> 'array'
     or jsonb_typeof(p_rules->'accepted_measurement_sources') <> 'array' then
    raise exception 'invalid cadence or measurement policy';
  end if;
  select coalesce(array_agg(distinct value), '{}') into v_cadences
    from jsonb_array_elements_text(p_rules->'permitted_cadences');
  select coalesce(array_agg(distinct value), '{}') into v_confidences
    from jsonb_array_elements_text(p_rules->'accepted_measurement_confidences');
  select coalesce(array_agg(distinct btrim(value)), '{}') into v_sources
    from jsonb_array_elements_text(p_rules->'accepted_measurement_sources') where btrim(value) <> '';
  if cardinality(v_cadences) = 0
     or not v_cadences <@ array['one_time','weekly','biweekly','monthly','seasonal']::text[] then
    raise exception 'invalid permitted cadences';
  end if;
  if cardinality(v_confidences) = 0
     or not v_confidences <@ array['high','medium','low']::text[]
     or cardinality(v_sources) = 0 then
    raise exception 'save accepted server measurement evidence';
  end if;
  if (p_rules->>'maximum_measurement_age_minutes')::integer not between 1 and 10080 then
    raise exception 'invalid maximum measurement age';
  end if;

  v_base_prices := p_rules->'base_prices';
  if jsonb_typeof(v_base_prices) <> 'object'
     or exists (select 1 from unnest(v_cadences) cadence
       where not v_base_prices ? cadence
          or nullif(v_base_prices->>cadence,'') is null
          or nullif(v_base_prices->>cadence,'')::numeric <= 0) then
    raise exception 'save a positive base price for every permitted cadence';
  end if;
  if (p_rules->>'base_lawn_sqft')::numeric <= 0
     or (p_rules->>'additional_price_per_1000_sqft')::numeric < 0
     or (p_rules->>'additional_area_price')::numeric < 0
     or (p_rules->>'loaded_labour_cost_per_hour')::numeric <= 0
     or (p_rules->>'equipment_cost_per_visit')::numeric < 0
     or (p_rules->>'delivery_cost_per_visit')::numeric < 0
     or (p_rules->>'disposal_cost_per_visit')::numeric < 0
     or (p_rules->>'overhead_cost_per_visit')::numeric < 0
     or (p_rules->>'contingency_percent')::numeric not between 0 and 100
     or (p_rules->>'vehicle_cost_per_km')::numeric < 0
     or (p_rules->>'included_route_km')::numeric < 0
     or (p_rules->>'route_price_per_additional_km')::numeric < 0
     or (p_rules->>'minimum_nearby_jobs_for_base')::integer < 0
     or (p_rules->>'isolated_stop_premium')::numeric < 0
     or (p_rules->>'maximum_automatic_distance_km')::numeric <= 0
     or (p_rules->>'maximum_route_premium')::numeric < 0
     or (p_rules->>'maximum_automatic_price')::numeric <= 0
     or (p_rules->>'payment_fee_percent')::numeric not between 0 and 99.99
     or (p_rules->>'payment_fee_fixed')::numeric < 0
     or (p_rules->>'minimum_margin_percent')::numeric not between 0 and 99.99
     or (p_rules->>'price_rounding_increment')::numeric <= 0
     or (p_rules->>'payment_fee_percent')::numeric + (p_rules->>'minimum_margin_percent')::numeric >= 100 then
    raise exception 'invalid price, cost, route or margin value';
  end if;

  v_bands := p_rules->'duration_crew_bands';
  if jsonb_typeof(v_bands) <> 'array' or jsonb_array_length(v_bands) = 0
     or exists (select 1 from jsonb_array_elements(v_bands) band
       where jsonb_typeof(band) <> 'object'
          or not band ?& array['minutes','crew_size','maximum_sqft']
          or (band->>'minutes')::numeric <= 0
          or (band->>'crew_size')::integer < 1
          or (jsonb_typeof(band->'maximum_sqft') <> 'null' and (band->>'maximum_sqft')::numeric <= 0))
     or not exists (select 1 from jsonb_array_elements(v_bands) band
       where jsonb_typeof(band->'maximum_sqft') = 'null') then
    raise exception 'save valid duration and crew bands including an open-ended band';
  end if;

  v_materials := p_rules->'materials';
  if jsonb_typeof(v_materials) <> 'array' then raise exception 'invalid material inputs'; end if;
  if v_service in ('fertilization','overseeding','topsoil','weed_treatment') then
    if coalesce((p_rules->>'materials_cost_basis_confirmed')::boolean, false) is not true
       or jsonb_array_length(v_materials) = 0
       or exists (select 1 from jsonb_array_elements(v_materials) material
         where jsonb_typeof(material) <> 'object'
           or not material ?& array['key','package_cost','package_quantity','application_quantity_per_1000_sqft','waste_percent','minimum_packages']
           or btrim(coalesce(material->>'key','')) = ''
           or nullif(material->>'package_cost','') is null
           or nullif(material->>'package_quantity','') is null
           or nullif(material->>'application_quantity_per_1000_sqft','') is null
           or nullif(material->>'waste_percent','') is null
           or nullif(material->>'minimum_packages','') is null
           or (material->>'package_cost')::numeric <= 0
           or (material->>'package_quantity')::numeric <= 0
           or (material->>'application_quantity_per_1000_sqft')::numeric <= 0
           or (material->>'waste_percent')::numeric not between 0 and 100
           or (material->>'minimum_packages')::integer < 0) then
      raise exception 'confirm complete product, package, application, waste and minimum-package costs';
    end if;
  end if;

  -- Snow requires its own explicit owner authorization and route binding. No
  -- generic mowing rule may silently turn it on.
  if v_service = 'snow' and (
       coalesce((p_rules->>'snow_owner_authorized')::boolean, false) is not true
       or btrim(coalesce(p_rules->>'snow_route_binding_version','')) = '') then
    raise exception 'authorize snow pricing and bind an approved snow route version';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|automatic-service-pricing|' || v_service, 0));
  select coalesce(max(version),0) + 1 into v_version
    from public.automatic_service_pricing_versions
   where user_id = v_user and service_key = v_service;
  update public.automatic_service_pricing_versions set is_active = false
   where user_id = v_user and service_key = v_service and is_active;

  v_hash := encode(extensions.digest(convert_to(p_rules::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.automatic_service_pricing_versions (
    user_id, service_key, version, created_by, confirmed_at, enabled,
    engine_version, route_rule_version, rules, rules_hash
  ) values (
    v_user, v_service, v_version, v_user, now(),
    coalesce((p_rules->>'enabled')::boolean, false), v_engine, v_route_version, p_rules, v_hash
  ) returning id into v_id;
  return jsonb_build_object('state','saved','id',v_id,'version',v_version,'rules_hash',v_hash);
end;
$function$;

comment on table public.automatic_service_pricing_versions is
  'Append-only owner authorization for automatic service estimates. No active row means manual review.';

-- Bundle pricing is a separate immutable owner decision. No row means two or
-- more otherwise-priced services must return to written review; the server may
-- not invent a discount or silently assume that no discount was intended.
create table if not exists public.automatic_bundle_pricing_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null,
  is_active boolean not null default true,
  enabled boolean not null default false,
  engine_version text not null check (length(btrim(engine_version)) between 1 and 80),
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  rules_hash text not null check (rules_hash ~ '^[0-9a-f]{64}$'),
  unique (user_id, version)
);

create unique index if not exists automatic_bundle_pricing_one_active
  on public.automatic_bundle_pricing_versions(user_id) where is_active;

alter table public.automatic_bundle_pricing_versions enable row level security;
drop policy if exists "automatic bundle pricing: select own" on public.automatic_bundle_pricing_versions;
create policy "automatic bundle pricing: select own" on public.automatic_bundle_pricing_versions
  for select to authenticated using (auth.uid() = user_id);

drop trigger if exists automatic_bundle_pricing_versions_immutable
  on public.automatic_bundle_pricing_versions;
create trigger automatic_bundle_pricing_versions_immutable before update or delete
  on public.automatic_bundle_pricing_versions for each row
  execute function public.automatic_service_pricing_versions_guard();

create or replace function public.save_automatic_bundle_pricing_version(p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_version integer;
  v_id uuid;
  v_engine text;
  v_kind text;
  v_value numeric;
  v_max numeric;
  v_margin numeric;
  v_hash text;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(p_rules) <> 'object' or not p_rules ?& array[
    'enabled','engine_version','minimum_services','discount_kind','discount_value',
    'maximum_discount','minimum_margin_percent'
  ] then raise exception 'complete every bundle pricing input'; end if;
  v_engine := btrim(coalesce(p_rules->>'engine_version',''));
  v_kind := lower(btrim(coalesce(p_rules->>'discount_kind','')));
  v_value := (p_rules->>'discount_value')::numeric;
  v_max := (p_rules->>'maximum_discount')::numeric;
  v_margin := (p_rules->>'minimum_margin_percent')::numeric;
  if length(v_engine) not between 1 and 80
     or (p_rules->>'minimum_services')::integer not between 2 and 12
     or v_kind not in ('none','percentage','fixed')
     or v_value < 0 or v_max < 0 or v_margin not between 0 and 99.99
     or (v_kind = 'none' and v_value <> 0)
     or (v_kind = 'percentage' and v_value >= 100)
     or (v_kind = 'fixed' and v_value > v_max) then
    raise exception 'invalid bundle pricing rule';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|automatic-bundle-pricing', 0));
  select coalesce(max(version),0) + 1 into v_version
    from public.automatic_bundle_pricing_versions where user_id = v_user;
  update public.automatic_bundle_pricing_versions set is_active = false
    where user_id = v_user and is_active;
  v_hash := encode(extensions.digest(convert_to(p_rules::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.automatic_bundle_pricing_versions (
    user_id, version, created_by, confirmed_at, enabled, engine_version, rules, rules_hash
  ) values (
    v_user, v_version, v_user, now(), coalesce((p_rules->>'enabled')::boolean, false),
    v_engine, p_rules, v_hash
  ) returning id into v_id;
  return jsonb_build_object('state','saved','id',v_id,'version',v_version,'rules_hash',v_hash);
end;
$function$;

comment on table public.automatic_bundle_pricing_versions is
  'Append-only owner authorization for multi-service totals and discounts. No active row means written review.';

create table if not exists public.automatic_quote_day_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null,
  property_id uuid not null,
  quote_id uuid not null,
  automatic_pricing_version_id uuid not null,
  schedule_item_id uuid not null,
  requested_date date not null,
  status text not null default 'pending_owner_review'
    check (status in ('pending_owner_review','confirmed','cancelled','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  cancel_reason text,
  check (expires_at > created_at)
);

alter table public.schedule_items
  add constraint schedule_items_user_id_id_key unique (user_id, id);
alter table public.automatic_quote_day_holds
  add constraint automatic_quote_day_holds_customer_same_owner
    foreign key (user_id, customer_id) references public.customers(user_id, id) on delete cascade,
  add constraint automatic_quote_day_holds_property_same_owner
    foreign key (property_id, user_id) references public.properties(id, user_id) on delete cascade,
  add constraint automatic_quote_day_holds_quote_same_owner
    foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete cascade,
  add constraint automatic_quote_day_holds_pricing_same_owner
    foreign key (user_id, automatic_pricing_version_id)
    references public.automatic_service_pricing_versions(user_id, id),
  add constraint automatic_quote_day_holds_schedule_item_same_owner
    foreign key (user_id, schedule_item_id) references public.schedule_items(user_id, id) on delete cascade;

create unique index if not exists automatic_quote_day_holds_one_active
  on public.automatic_quote_day_holds(quote_id)
  where status in ('pending_owner_review','confirmed');
create index if not exists automatic_quote_day_holds_owner_queue
  on public.automatic_quote_day_holds(user_id, status, requested_date);

alter table public.automatic_quote_day_holds enable row level security;
drop policy if exists "automatic day holds: select own" on public.automatic_quote_day_holds;
create policy "automatic day holds: select own" on public.automatic_quote_day_holds
  for select to authenticated using (auth.uid() = user_id);

-- Expiry is deliberately a separate statement from availability. The existing
-- availability RPC is STABLE, so writes made earlier inside the same outer SQL
-- statement must not be assumed visible to its snapshot.
create or replace function public.expire_automatic_quote_day_holds(p_token text)
returns integer
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid;
  v_count integer := 0;
  v_hold public.automatic_quote_day_holds;
begin
  select t.user_id into v_user from public.customer_portal_tokens t
   where t.token = p_token and not t.revoked;
  if v_user is null then return 0; end if;
  for v_hold in select * from public.automatic_quote_day_holds h
    where h.user_id = v_user and h.status = 'pending_owner_review' and h.expires_at <= now()
    for update
  loop
    update public.automatic_quote_day_holds set status='expired',reviewed_at=now(),
      cancel_reason='Tentative day request expired before owner review.' where id=v_hold.id;
    update public.schedule_items set status='cancelled',updated_at=now(),
      cancel_reason='Tentative day request expired before owner review.'
      where id=v_hold.schedule_item_id and user_id=v_user and status='scheduled';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.reserve_automatic_quote_day(
  p_token text,
  p_quote_id uuid,
  p_date date
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_customer uuid;
  v_user uuid;
  v_q public.quotes;
  v_avail jsonb;
  v_hold public.automatic_quote_day_holds;
  v_schedule_item uuid;
  v_pricing_version uuid;
  v_duration integer;
  v_extra_duration integer := 0;
  v_settings public.business_settings;
  v_hold_cfg jsonb;
  v_hold_hours integer;
begin
  select t.customer_id, t.user_id into v_customer, v_user
    from public.customer_portal_tokens t
   where t.token = p_token and not t.revoked;
  if v_customer is null then return jsonb_build_object('state','invalid_link'); end if;
  if p_date is null then return jsonb_build_object('state','invalid_date'); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|automatic-day-hold|' || p_quote_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || '|automatic-day-hold-date|' || p_date::text, 0));
  select * into v_q from public.quotes q
   where q.id = p_quote_id and q.customer_id = v_customer and q.user_id = v_user
   for update;
  if not found then return jsonb_build_object('state','invalid_quote'); end if;
  if v_q.status <> 'accepted' or public.quote_acceptance_is_current(v_q.id) is distinct from true then
    return jsonb_build_object('state','awaiting_acceptance');
  end if;
  if v_q.property_id is null then return jsonb_build_object('state','review_required','reason','property_missing'); end if;
  begin
    v_pricing_version := nullif(v_q.lead_meta->>'automatic_pricing_version_id','')::uuid;
  exception when others then
    return jsonb_build_object('state','review_required','reason','automatic_pricing_version_invalid');
  end;
  if v_pricing_version is null
     or coalesce(v_q.lead_meta->>'automatic_price_state','') <> 'priced'
     or coalesce(v_q.lead_meta->>'automatic_estimate_status','') <> 'written_estimate'
     or coalesce(v_q.lead_meta->>'automatic_price_idempotency_key','') !~ '^[0-9a-f]{64}$'
     or not exists (
       select 1 from public.automatic_service_pricing_versions p
        where p.id = v_pricing_version and p.user_id = v_user and p.is_active and p.enabled
          and p.service_key = v_q.lead_meta->>'automatic_service_key'
          and p.rules_hash = v_q.lead_meta->>'automatic_pricing_rules_hash'
          and p.engine_version = v_q.lead_meta->>'automatic_pricing_engine_version'
          and p.route_rule_version = v_q.lead_meta->>'automatic_route_rule_version') then
    return jsonb_build_object('state','review_required','reason','automatic_pricing_version_changed');
  end if;
  select * into v_settings from public.business_settings b where b.user_id=v_user;
  v_hold_cfg := v_settings.module_meta->'automatic_quote_day_holds';
  if not found or jsonb_typeof(v_hold_cfg) <> 'object'
     or coalesce(v_hold_cfg->>'enabled','') <> 'true'
     or coalesce(v_hold_cfg->>'confirmed_at','') = ''
     or coalesce(v_hold_cfg->>'tentative_hold_hours','') !~ '^[0-9]{1,3}$' then
    return jsonb_build_object('state','review_required','reason','tentative_hold_rules_missing');
  end if;
  v_hold_hours := (v_hold_cfg->>'tentative_hold_hours')::integer;
  if v_hold_hours not between 1 and 168 then
    return jsonb_build_object('state','review_required','reason','tentative_hold_rules_invalid');
  end if;

  select * into v_hold from public.automatic_quote_day_holds h
   where h.user_id = v_user and h.quote_id = v_q.id
     and h.status in ('pending_owner_review','confirmed')
   order by h.created_at desc limit 1 for update;
  if found and v_hold.requested_date = p_date then
    return jsonb_build_object(
      'state', case when v_hold.status = 'confirmed' then 'confirmed' else 'held_for_review' end,
      'hold_id', v_hold.id, 'date', v_hold.requested_date, 'arrival_time', null,
      'expires_at', case when v_hold.status = 'pending_owner_review' then v_hold.expires_at else null end);
  elsif found and v_hold.status = 'confirmed' then
    return jsonb_build_object('state','review_required','reason','confirmed_day_change_requires_owner');
  elsif found then
    return jsonb_build_object('state','review_required','reason','existing_day_change_requires_owner');
  end if;

  v_avail := public.public_quote_schedule_availability(p_token, p_quote_id, 60);
  if coalesce(v_avail->>'state','') <> 'ready'
     or not exists (
       select 1 from jsonb_array_elements(coalesce(v_avail->'dates','[]'::jsonb)) day
        where day->>'date' = p_date::text) then
    return v_avail || jsonb_build_object('selected_date',p_date);
  end if;

  select coalesce(sum(qs.est_minutes),0)::integer into v_extra_duration
    from public.quote_services qs
   where qs.user_id = v_user and qs.quote_id = v_q.id
     and qs.id is distinct from (
       select first_qs.id from public.quote_services first_qs
        where first_qs.user_id = v_user and first_qs.quote_id = v_q.id
        order by first_qs.sort_order, first_qs.created_at, first_qs.id limit 1);
  v_duration := round(v_q.hours * 60)::integer + v_extra_duration;
  if coalesce(v_duration,0) <= 0 then return jsonb_build_object('state','review_required','reason','duration_missing'); end if;

  insert into public.schedule_items (
    user_id, type, title, customer_id, property_id, scheduled_date,
    start_time, duration_minutes, notes, status, converted_quote_id, customer_note
  ) values (
    v_user, 'appointment', left('Tentative service-day request — ' || v_q.customer_name, 200),
    v_customer, v_q.property_id, p_date, null, v_duration,
    'Customer selected a day after accepting an automatic written estimate. Owner review is required; no arrival time or job has been promised.',
    'scheduled', v_q.id, 'Requested service day; pending owner review. No arrival time is promised.'
  ) returning id into v_schedule_item;

  insert into public.automatic_quote_day_holds (
    user_id, customer_id, property_id, quote_id, automatic_pricing_version_id,
    schedule_item_id, requested_date, expires_at
  ) values (
    v_user, v_customer, v_q.property_id, v_q.id, v_pricing_version,
    v_schedule_item, p_date, now() + make_interval(hours => v_hold_hours)
  ) returning * into v_hold;

  insert into public.service_requests(user_id,customer_id,message)
  values (v_user,v_customer,
    'Review requested service day ' || p_date::text || ' for accepted automatic quote ' || v_q.quote_number || '. No arrival time is promised.');

  return jsonb_build_object(
    'state','held_for_review','hold_id',v_hold.id,'date',p_date,
    'arrival_time',null,'expires_at',v_hold.expires_at);
end;
$function$;

create or replace function public.review_automatic_quote_day_hold(
  p_hold_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_hold public.automatic_quote_day_holds;
  v_action text := lower(btrim(coalesce(p_action,'')));
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if v_action not in ('confirm','cancel') then return jsonb_build_object('state','invalid_action'); end if;
  select * into v_hold from public.automatic_quote_day_holds h
   where h.id = p_hold_id and h.user_id = v_user for update;
  if not found then return jsonb_build_object('state','not_found'); end if;
  if v_hold.status <> 'pending_owner_review' then
    return jsonb_build_object('state',v_hold.status,'date',v_hold.requested_date);
  end if;
  if v_action = 'confirm' then
    if v_hold.expires_at <= now() then
      update public.automatic_quote_day_holds set status='expired',reviewed_at=now(),reviewed_by=v_user,
        cancel_reason='Expired before owner confirmation.' where id=v_hold.id;
      update public.schedule_items set status='cancelled',updated_at=now(),
        cancel_reason='Expired before owner confirmation.' where id=v_hold.schedule_item_id and user_id=v_user;
      return jsonb_build_object('state','expired');
    end if;
    update public.automatic_quote_day_holds set status='confirmed',reviewed_at=now(),reviewed_by=v_user
      where id=v_hold.id;
    update public.schedule_items set customer_note='Service day confirmed by owner. Arrival time is not yet promised.',updated_at=now()
      where id=v_hold.schedule_item_id and user_id=v_user and status='scheduled';
    return jsonb_build_object('state','confirmed','date',v_hold.requested_date,'arrival_time',null);
  end if;
  update public.automatic_quote_day_holds set status='cancelled',reviewed_at=now(),reviewed_by=v_user,
    cancel_reason=left(nullif(btrim(p_reason),''),500) where id=v_hold.id;
  update public.schedule_items set status='cancelled',updated_at=now(),
    cancel_reason=coalesce(left(nullif(btrim(p_reason),''),500),'Cancelled by owner.')
    where id=v_hold.schedule_item_id and user_id=v_user and status='scheduled';
  return jsonb_build_object('state','cancelled');
end;
$function$;

create or replace function public.configure_automatic_quote_day_holds(
  p_enabled boolean,
  p_tentative_hold_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_cfg jsonb;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_tentative_hold_hours is null or p_tentative_hold_hours not between 1 and 168 then
    return jsonb_build_object('state','invalid_rules');
  end if;
  v_cfg := jsonb_build_object(
    'enabled',coalesce(p_enabled,false),
    'tentative_hold_hours',p_tentative_hold_hours,
    'confirmed_at',now(),
    'confirmed_by',v_user);
  update public.business_settings set module_meta=jsonb_set(
    coalesce(module_meta,'{}'::jsonb),'{automatic_quote_day_holds}',v_cfg,true)
   where user_id=v_user;
  if not found then return jsonb_build_object('state','settings_missing'); end if;
  return jsonb_build_object('state','saved','config',v_cfg);
end;
$function$;

revoke all on table public.automatic_service_pricing_versions from public, anon, authenticated, service_role;
grant select on table public.automatic_service_pricing_versions to authenticated;
grant all on table public.automatic_service_pricing_versions to service_role;
revoke all on table public.automatic_bundle_pricing_versions from public, anon, authenticated, service_role;
grant select on table public.automatic_bundle_pricing_versions to authenticated;
grant all on table public.automatic_bundle_pricing_versions to service_role;
revoke all on table public.automatic_quote_day_holds from public, anon, authenticated, service_role;
grant select on table public.automatic_quote_day_holds to authenticated;
grant all on table public.automatic_quote_day_holds to service_role;

revoke all on function public.save_automatic_service_pricing_version(text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_automatic_service_pricing_version(text,jsonb) to authenticated;
revoke all on function public.save_automatic_bundle_pricing_version(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_automatic_bundle_pricing_version(jsonb) to authenticated;
revoke all on function public.reserve_automatic_quote_day(text,uuid,date)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_automatic_quote_day(text,uuid,date) to service_role;
revoke all on function public.expire_automatic_quote_day_holds(text)
  from public, anon, authenticated, service_role;
grant execute on function public.expire_automatic_quote_day_holds(text) to service_role;
revoke all on function public.review_automatic_quote_day_hold(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_automatic_quote_day_hold(uuid,text,text) to authenticated;
revoke all on function public.configure_automatic_quote_day_holds(boolean,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_automatic_quote_day_holds(boolean,integer) to authenticated;

comment on table public.automatic_quote_day_holds is
  'Day-only customer requests that reserve EdgeHQ capacity pending owner review; never a job or payment.';
