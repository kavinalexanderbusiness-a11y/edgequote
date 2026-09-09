-- DORMANT PROPOSAL ONLY. Not a migration, not applied, no activation authority.
-- Base 0bb65f2bb53009b8a67364536df7932498c8a845. Requires the existing baseline.
-- Four empty private tables; no seeds, backfill, founder grants or scheduler.
-- Parent indexes below are material DDL: pilot history RESTRICTs deletion and
-- reassignment of its quote/customer/native rows. Retention approval is separate.
begin;

create unique index pilot_quotes_owner_customer_id_key on public.quotes(user_id, customer_id, id);
create unique index pilot_messages_owner_customer_id_key on public.messages(user_id, customer_id, id);
create unique index pilot_logs_owner_customer_id_key on public.notification_log(user_id, customer_id, id);

create table public.pilot_email_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.business_settings(user_id) on delete restrict,
  account_scope text not null check (length(account_scope) between 1 and 128),
  credential_version text not null check (length(credential_version) between 1 and 128),
  secret_ref text not null check (secret_ref ~ '^[A-Za-z0-9_/-]{1,160}$'),
  from_address text not null check (from_address ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' and length(from_address) <= 254),
  receiving_domain text not null check (receiving_domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$' and length(receiving_domain) <= 190),
  state text not null default 'off' check (state in ('off','verified','active','paused','disconnected')),
  created_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz,
  disconnected_at timestamptz,
  unique (id,user_id,account_scope,credential_version),
  check ((state in ('verified','active','paused') and verified_at is not null and disconnected_at is null)
    or (state='disconnected' and disconnected_at is not null)
    or (state='off' and verified_at is null and disconnected_at is null))
);
create unique index pilot_one_active_email_connection on public.pilot_email_connections(user_id) where state='active';

create table public.pilot_quote_followup_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  connection_id uuid not null,
  account_scope text not null,
  credential_version text not null,
  customer_id uuid not null,
  quote_id uuid not null,
  material_hash text not null check (material_hash ~ '^[a-f0-9]{32}$'),
  terms_hash text not null check (terms_hash ~ '^[a-f0-9]{32}$'),
  quote_sent_at timestamptz not null,
  recipient_email text not null,
  approved_by uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  approved_steps jsonb not null check (jsonb_typeof(approved_steps)='array' and jsonb_array_length(approved_steps) between 1 and 2),
  step_count smallint not null check (step_count between 1 and 2),
  state text not null default 'approved' check (state in ('approved','held','completed')),
  hold_reason text check (hold_reason in ('owner_paused','reply_received','reply_review','quote_changed','quote_decided','invoiced','expired','consent_changed','recipient_changed','connection_unavailable','needs_review')),
  created_at timestamptz not null default clock_timestamp(),
  held_at timestamptz,
  foreign key(connection_id,user_id,account_scope,credential_version)
    references public.pilot_email_connections(id,user_id,account_scope,credential_version) on delete restrict,
  foreign key(user_id,customer_id) references public.customers(user_id,id) on delete restrict,
  foreign key(user_id,customer_id,quote_id) references public.quotes(user_id,customer_id,id) on delete restrict,
  unique(quote_id,quote_sent_at,material_hash,terms_hash),
  unique(id,user_id,connection_id,customer_id,quote_id),
  check (jsonb_array_length(approved_steps)=step_count),
  check (approved_by=user_id),
  check ((state='held') = (hold_reason is not null and held_at is not null))
);
create index pilot_workflows_owner_state on public.pilot_quote_followup_workflows(user_id,state);

create table public.pilot_email_send_attempts (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  user_id uuid not null,
  connection_id uuid not null,
  customer_id uuid not null,
  quote_id uuid not null,
  step smallint not null check(step between 1 and 2),
  due_at timestamptz not null,
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check(length(idempotency_key) between 1 and 256),
  reply_token text not null unique check(reply_token ~ '^[a-f0-9]{48}$'),
  state text not null default 'pending' check(state in ('pending','leased','started','confirmed','finalized','needs_review')),
  fence bigint not null default 0 check(fence>=0),
  lease_until timestamptz,
  first_started_at timestamptz,
  provider_email_id text check(length(provider_email_id) between 1 and 200),
  confirmed_at timestamptz,
  message_id uuid,
  notification_log_id uuid,
  error_code text check(error_code in ('provider_unknown','provider_refused','store_failed','window_expired')),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workflow_id,user_id,connection_id,customer_id,quote_id)
    references public.pilot_quote_followup_workflows(id,user_id,connection_id,customer_id,quote_id) on delete restrict,
  foreign key(user_id,customer_id,message_id) references public.messages(user_id,customer_id,id) on delete restrict,
  foreign key(user_id,customer_id,notification_log_id) references public.notification_log(user_id,customer_id,id) on delete restrict,
  unique(workflow_id,step),
  unique(connection_id,provider_email_id),
  unique(id,connection_id),
  unique(message_id), unique(notification_log_id),
  check ((provider_email_id is null) = (confirmed_at is null)),
  check ((message_id is null) = (notification_log_id is null)),
  check ((state='finalized') = (message_id is not null)),
  check (state not in ('started','confirmed','finalized') or first_started_at is not null),
  check (state not in ('confirmed','finalized') or provider_email_id is not null),
  check (state not in ('leased','started','confirmed') or lease_until is not null and fence>0)
);
create index pilot_attempts_owner_started on public.pilot_email_send_attempts(user_id,first_started_at) where first_started_at is not null;

create table public.pilot_email_webhook_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.pilot_email_connections(id) on delete restrict,
  provider_event_id text not null check(length(provider_event_id) between 1 and 200),
  event_type text not null check(event_type in ('email.received','email.sent','email.delivered','email.delivery_delayed','email.opened','email.clicked','email.bounced','email.complained')),
  provider_email_id text not null check(length(provider_email_id) between 1 and 200),
  route_token text check(route_token ~ '^[a-f0-9]{48}$'),
  attempt_id uuid,
  state text not null default 'pending' check(state in ('pending','processing','completed','needs_review')),
  fence bigint not null default 0 check(fence>=0),
  lease_until timestamptz,
  error_code text check(error_code in ('content_unavailable','metadata_mismatch','store_failed','unknown_route','sender_mismatch','awaiting_send')),
  received_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  native_message_id uuid references public.messages(id) on delete restrict,
  duplicate_of uuid references public.pilot_email_webhook_events(id) on delete restrict,
  foreign key(attempt_id,connection_id) references public.pilot_email_send_attempts(id,connection_id) on delete restrict,
  unique(connection_id,provider_event_id),
  check ((state='completed') = (completed_at is not null)),
  check (state <> 'processing' or lease_until is not null and fence>0),
  check (event_type='email.received' or route_token is null),
  check (duplicate_of is null or native_message_id is not null)
);
-- Only one canonical inbound event can own a native message for an email.
-- Further signed event IDs remain separate history rows referring to that one.
create unique index pilot_received_email_once on public.pilot_email_webhook_events(connection_id,provider_email_id)
  where event_type='email.received' and state='completed' and duplicate_of is null;
create index pilot_events_retry on public.pilot_email_webhook_events(state,lease_until);

alter table public.pilot_email_connections enable row level security;
alter table public.pilot_quote_followup_workflows enable row level security;
alter table public.pilot_email_send_attempts enable row level security;
alter table public.pilot_email_webhook_events enable row level security;
revoke all on public.pilot_email_connections, public.pilot_quote_followup_workflows,
  public.pilot_email_send_attempts, public.pilot_email_webhook_events from public,anon,authenticated,service_role;
-- Safe owner display must go through separately reviewed owner-checked server
-- code. Snapshots/secret references/event data are not owner-readable tables.
grant select on public.pilot_email_connections, public.pilot_quote_followup_workflows,
  public.pilot_email_send_attempts, public.pilot_email_webhook_events to service_role;

create function public._pilot_email_immutable() returns trigger
language plpgsql set search_path='' as $$
declare allowed text[];
begin
  if tg_op='DELETE' then raise exception 'pilot_history_retained' using errcode='23514'; end if;
  allowed := case tg_table_name
    when 'pilot_email_connections' then array['state','verified_at','disconnected_at']
    when 'pilot_quote_followup_workflows' then array['state','hold_reason','held_at']
    when 'pilot_email_send_attempts' then array['state','fence','lease_until','first_started_at','provider_email_id','confirmed_at','message_id','notification_log_id','error_code']
    when 'pilot_email_webhook_events' then array['attempt_id','state','fence','lease_until','error_code','completed_at','native_message_id','duplicate_of'] end;
  if (to_jsonb(new)-allowed) is distinct from (to_jsonb(old)-allowed) then
    raise exception 'pilot_binding_immutable' using errcode='23514';
  end if;
  if tg_table_name='pilot_email_send_attempts' then
    if ((old.first_started_at is not null and new.first_started_at is distinct from old.first_started_at)
    or (old.provider_email_id is not null and new.provider_email_id is distinct from old.provider_email_id)
    or (old.message_id is not null and (new.message_id is distinct from old.message_id or new.notification_log_id is distinct from old.notification_log_id))) then
      raise exception 'pilot_receipt_immutable' using errcode='23514';
    end if;
  end if;
  if tg_table_name='pilot_email_webhook_events' then
    if old.attempt_id is not null and new.attempt_id is distinct from old.attempt_id then
      raise exception 'pilot_event_binding_immutable' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger pilot_connection_immutable before update or delete on public.pilot_email_connections for each row execute function public._pilot_email_immutable();
create trigger pilot_workflow_immutable before update or delete on public.pilot_quote_followup_workflows for each row execute function public._pilot_email_immutable();
create trigger pilot_attempt_immutable before update or delete on public.pilot_email_send_attempts for each row execute function public._pilot_email_immutable();
create trigger pilot_event_immutable before update or delete on public.pilot_email_webhook_events for each row execute function public._pilot_email_immutable();

create function public._pilot_email_owner_lock(p_owner uuid) returns void
language sql set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended('pilot-email:'||p_owner::text,0));
$$;

create function public.pilot_email_create_connection(p_owner uuid,p_account_scope text,p_from_address text,p_receiving_domain text,p_secret_ref text,p_credential_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  perform public._pilot_email_owner_lock(p_owner);
  if not exists(select 1 from public.business_settings where user_id=p_owner) then return jsonb_build_object('code','owner_unavailable'); end if;
  insert into public.pilot_email_connections(user_id,account_scope,from_address,receiving_domain,secret_ref,credential_version)
  values(p_owner,p_account_scope,p_from_address,lower(p_receiving_domain),p_secret_ref,p_credential_version) returning id into v_id;
  return jsonb_build_object('code','created','connection_id',v_id);
end $$;

create function public.pilot_email_set_connection_state(p_connection uuid,p_state text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.pilot_email_connections;
begin
  select * into c from public.pilot_email_connections where id=p_connection;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(c.user_id);
  select * into c from public.pilot_email_connections where id=p_connection for update;
  if p_state=c.state then return jsonb_build_object('code','unchanged'); end if;
  if not ((c.state='off' and p_state='verified') or (c.state in ('verified','paused') and p_state='active')
    or (c.state='active' and p_state='paused') or (c.state<>'disconnected' and p_state='disconnected')) then
    return jsonb_build_object('code','invalid_transition'); end if;
  update public.pilot_email_connections set state=p_state,
    verified_at=case when p_state='verified' then clock_timestamp() else verified_at end,
    disconnected_at=case when p_state='disconnected' then clock_timestamp() else null end where id=c.id;
  return jsonb_build_object('code','updated');
end $$;

-- Caller is trusted service code that obtained explicit owner copy approval.
-- It cannot choose recipient/from, mint capabilities, or bypass canonical gates.
create function public.pilot_email_approve_workflow(p_connection uuid,p_customer uuid,p_quote uuid,p_steps jsonb,p_approved_by uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.pilot_email_connections; q public.quotes; customer public.customers;
  v_id uuid; v_material text; v_terms text; s jsonb; n smallint:=0; v_due timestamptz; v_prev timestamptz;
  a_id uuid; token text; body jsonb; prior public.pilot_quote_followup_workflows;
begin
  select * into c from public.pilot_email_connections where id=p_connection;
  if not found then return jsonb_build_object('code','not_found'); end if;
  if p_approved_by is distinct from c.user_id then return jsonb_build_object('code','approval_owner_mismatch'); end if;
  perform public._pilot_email_owner_lock(c.user_id);
  select * into c from public.pilot_email_connections where id=c.id for update;
  if c.state<>'active' then return jsonb_build_object('code','connection_unavailable'); end if;
  perform 1 from public.business_settings where user_id=c.user_id for share;
  select * into customer from public.customers where id=p_customer and user_id=c.user_id for share;
  if not found then return jsonb_build_object('code','customer_unavailable'); end if;
  select * into q from public.quotes where id=p_quote and user_id=c.user_id and customer_id=p_customer for update;
  if not found then return jsonb_build_object('code','quote_unavailable'); end if;
  if q.status<>'sent' or q.sent_at is null or public.quote_acceptance_is_current(q.id) then return jsonb_build_object('code','quote_decided'); end if;
  if not customer.email_opt_in or coalesce(customer.message_prefs->'estimates','null'::jsonb)='false'::jsonb then return jsonb_build_object('code','consent_changed'); end if;
  if customer.email is null or customer.email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then return jsonb_build_object('code','recipient_changed'); end if;
  if exists(select 1 from public.messages where user_id=c.user_id and customer_id=p_customer and direction='inbound' and channel in ('email','sms','portal') and created_at>=q.sent_at) then
    return jsonb_build_object('code','reply_received'); end if;
  if exists(select 1 from public.pilot_email_webhook_events e join public.pilot_email_send_attempts x on x.id=e.attempt_id
    where x.user_id=c.user_id and x.customer_id=p_customer and x.quote_id=q.id and e.event_type='email.received' and e.received_at>=q.sent_at) then
    return jsonb_build_object('code','reply_received'); end if;
  -- Existing row edits are locked; inserts reference the FOR UPDATE parent.
  perform 1 from public.quote_services where quote_id=q.id for share;
  perform 1 from public.quote_options where quote_id=q.id for share;
  perform 1 from public.quote_addons where quote_id=q.id for share;
  v_material:=public.quote_material_fingerprint(q.id); v_terms:=public.quote_terms_fingerprint(c.user_id);
  select * into prior from public.pilot_quote_followup_workflows where quote_id=q.id and quote_sent_at=q.sent_at and material_hash=v_material and terms_hash=v_terms;
  if found then
    if prior.connection_id<>c.id or prior.approved_steps is distinct from p_steps then return jsonb_build_object('code','approval_conflict'); end if;
    return jsonb_build_object('code','existing','workflow_id',prior.id,'step_count',prior.step_count);
  end if;
  if p_steps is null or jsonb_typeof(p_steps)<>'array' or jsonb_array_length(p_steps) not between 1 and 2 then return jsonb_build_object('code','invalid_steps'); end if;
  for s in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(s)<>'object' or (s-array['subject','text','html','due_at'])<>'{}'::jsonb
      or jsonb_typeof(s->'subject') is distinct from 'string' or length(s->>'subject') not between 1 and 500
      or (s->>'subject') ~ E'[\r\n]' or jsonb_typeof(s->'text') is distinct from 'string' or length(s->>'text') not between 1 and 30000
      or (s ? 'html' and (jsonb_typeof(s->'html') is distinct from 'string' or length(s->>'html') not between 1 and 100000))
      or jsonb_typeof(s->'due_at') is distinct from 'string' then return jsonb_build_object('code','invalid_steps'); end if;
    begin v_due:=(s->>'due_at')::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('code','invalid_steps'); end;
    if not isfinite(v_due) or v_due<q.sent_at or (v_prev is not null and v_due<=v_prev) then return jsonb_build_object('code','invalid_steps'); end if;
    v_prev:=v_due;
  end loop;
  insert into public.pilot_quote_followup_workflows(user_id,connection_id,account_scope,credential_version,customer_id,quote_id,material_hash,terms_hash,quote_sent_at,recipient_email,approved_by,approved_steps,step_count)
  values(c.user_id,c.id,c.account_scope,c.credential_version,p_customer,q.id,v_material,v_terms,q.sent_at,customer.email,p_approved_by,p_steps,jsonb_array_length(p_steps)) returning id into v_id;
  for s in select value from jsonb_array_elements(p_steps) loop
    n:=n+1; a_id:=gen_random_uuid(); token:=encode(extensions.gen_random_bytes(24),'hex');
    body:=jsonb_build_object('from',c.from_address,'to',jsonb_build_array(customer.email),'reply_to',token||'@'||c.receiving_domain,'subject',s->>'subject','text',s->>'text');
    if s ? 'html' then body:=body||jsonb_build_object('html',s->>'html'); end if;
    insert into public.pilot_email_send_attempts(id,workflow_id,user_id,connection_id,customer_id,quote_id,step,due_at,payload,payload_hash,idempotency_key,reply_token)
    values(a_id,v_id,c.user_id,c.id,p_customer,q.id,n,(s->>'due_at')::timestamptz,body,encode(extensions.digest(body::text,'sha256'),'hex'),'pilot-email/'||a_id::text,token);
  end loop;
  return jsonb_build_object('code','approved','workflow_id',v_id,'step_count',n);
end $$;

create function public.pilot_email_hold_workflow(p_workflow uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.pilot_quote_followup_workflows;
begin
  if p_reason is null or p_reason not in ('owner_paused','reply_received','reply_review','needs_review') then return jsonb_build_object('code','invalid_reason'); end if;
  select * into w from public.pilot_quote_followup_workflows where id=p_workflow;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(w.user_id);
  update public.pilot_quote_followup_workflows set state='held',hold_reason=p_reason,held_at=coalesce(held_at,clock_timestamp()) where id=w.id;
  return jsonb_build_object('code','held');
end $$;

create function public.pilot_email_claim(p_workflow uuid,p_step integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.pilot_quote_followup_workflows; a public.pilot_email_send_attempts; t timestamptz:=clock_timestamp();
begin
  select * into w from public.pilot_quote_followup_workflows where id=p_workflow;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(w.user_id);
  select * into w from public.pilot_quote_followup_workflows where id=w.id for update;
  t:=clock_timestamp();
  select * into a from public.pilot_email_send_attempts where workflow_id=w.id and step=p_step for update;
  if not found then return jsonb_build_object('code','not_found'); end if;
  if a.state='finalized' then return jsonb_build_object('code','finalized','attempt_id',a.id,'message_id',a.message_id,'notification_log_id',a.notification_log_id); end if;
  if a.lease_until>t then return jsonb_build_object('code','busy'); end if;
  if a.provider_email_id is null then
    if a.state='needs_review' then return jsonb_build_object('code','needs_review'); end if;
    if w.state<>'approved' then return jsonb_build_object('code','held'); end if;
    if a.due_at>t then return jsonb_build_object('code','not_due'); end if;
    if a.step=2 and not exists(select 1 from public.pilot_email_send_attempts where workflow_id=w.id and step=1 and state='finalized') then return jsonb_build_object('code','prior_step_pending'); end if;
    -- 23 hours leaves one hour of provider retention margin. Never reset it.
    if a.first_started_at is not null and a.first_started_at+interval '23 hours'<=t then
      update public.pilot_email_send_attempts set state='needs_review',error_code='window_expired',lease_until=null where id=a.id;
      return jsonb_build_object('code','needs_review'); end if;
  end if;
  update public.pilot_email_send_attempts set state=case when provider_email_id is not null then 'confirmed' else 'leased' end,
    fence=fence+1,lease_until=clock_timestamp()+interval '2 minutes',error_code=null where id=a.id returning * into a;
  return jsonb_build_object('code',case when a.provider_email_id is null then 'claimed' else 'reconcile' end,'attempt_id',a.id,'fence',a.fence,'lease_until',a.lease_until);
end $$;

create function public.pilot_email_start(p_attempt uuid,p_fence bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.pilot_email_send_attempts; w public.pilot_quote_followup_workflows; c public.pilot_email_connections;
  q public.quotes; customer public.customers; v_zone text; v_reason text; v_count bigint; t timestamptz;
begin
  select * into a from public.pilot_email_send_attempts where id=p_attempt;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(a.user_id);
  select * into a from public.pilot_email_send_attempts where id=a.id for update;
  t:=clock_timestamp();
  if a.fence is distinct from p_fence or a.lease_until is null or a.lease_until<=t then return jsonb_build_object('code','stale_lease'); end if;
  if a.state<>'leased' then return jsonb_build_object('code','invalid_state'); end if;
  select * into c from public.pilot_email_connections where id=a.connection_id for update;
  select timezone into v_zone from public.business_settings where user_id=a.user_id for share;
  select * into customer from public.customers where id=a.customer_id and user_id=a.user_id for share;
  select * into q from public.quotes where id=a.quote_id and user_id=a.user_id and customer_id=a.customer_id for update;
  select * into w from public.pilot_quote_followup_workflows where id=a.workflow_id for update;
  perform 1 from public.quote_services where quote_id=q.id for share;
  perform 1 from public.quote_options where quote_id=q.id for share;
  perform 1 from public.quote_addons where quote_id=q.id for share;
  t:=clock_timestamp();
  if a.lease_until<=t then return jsonb_build_object('code','stale_lease'); end if;
  if v_zone is null or not exists(select 1 from pg_timezone_names where name=v_zone) then return jsonb_build_object('code','clock_unavailable'); end if;
  -- Explicitly stricter pilot rule, not native estimate-followup governance.
  if extract(hour from t at time zone v_zone)<8 or extract(hour from t at time zone v_zone)>=21 then return jsonb_build_object('code','quiet_hours'); end if;
  -- Parent quote lock serializes current acceptance/status/FK insert writers;
  -- customer and business locks serialize committed consent/terms changes.
  if c.state<>'active' or c.account_scope<>w.account_scope or c.credential_version<>w.credential_version then v_reason:='connection_unavailable';
  elsif w.state<>'approved' then return jsonb_build_object('code','held');
  elsif q.status<>'sent' or public.quote_acceptance_is_current(q.id) then v_reason:='quote_decided';
  elsif q.sent_at is distinct from w.quote_sent_at or public.quote_material_fingerprint(q.id) is distinct from w.material_hash or public.quote_terms_fingerprint(w.user_id) is distinct from w.terms_hash then v_reason:='quote_changed';
  elsif exists(select 1 from public.invoices where user_id=a.user_id and quote_id=a.quote_id) then v_reason:='invoiced';
  elsif q.valid_until is not null and q.valid_until<(t at time zone v_zone)::date then v_reason:='expired';
  elsif not customer.email_opt_in or coalesce(customer.message_prefs->'estimates','null'::jsonb)='false'::jsonb then v_reason:='consent_changed';
  elsif customer.email is distinct from w.recipient_email then v_reason:='recipient_changed';
  elsif exists(select 1 from public.messages where user_id=a.user_id and customer_id=a.customer_id and direction='inbound' and channel in ('sms','email','portal') and created_at>=w.quote_sent_at) then v_reason:='reply_received';
  elsif exists(select 1 from public.pilot_email_webhook_events e join public.pilot_email_send_attempts x on x.id=e.attempt_id
    where x.user_id=a.user_id and x.customer_id=a.customer_id and x.quote_id=a.quote_id and e.event_type='email.received' and e.received_at>=w.quote_sent_at) then v_reason:='reply_received';
  end if;
  if v_reason is not null then
    update public.pilot_quote_followup_workflows set state='held',hold_reason=v_reason,held_at=coalesce(held_at,t) where id=w.id;
    return jsonb_build_object('code',v_reason); end if;
  if a.first_started_at is not null and a.first_started_at+interval '23 hours'<=t then
    update public.pilot_email_send_attempts set state='needs_review',error_code='window_expired',lease_until=null where id=a.id;
    return jsonb_build_object('code','needs_review'); end if;
  if a.due_at>t then return jsonb_build_object('code','not_due'); end if;
  if a.step=2 and not exists(select 1 from public.pilot_email_send_attempts where workflow_id=w.id and step=1 and state='finalized') then return jsonb_build_object('code','prior_step_pending'); end if;
  -- Existing governor's all-template 500/day cap; count in-flight pilot work
  -- too, without double counting finalized native logs or this same retry.
  if a.first_started_at is null then
    select count(*) into v_count from public.notification_log where user_id=a.user_id
      and status in ('sent','delivered','opened','clicked','failed','bounced','spam')
      and created_at>=date_trunc('day',t at time zone 'UTC') at time zone 'UTC';
    v_count:=v_count+(select count(*) from public.pilot_email_send_attempts where user_id=a.user_id
      and first_started_at>=date_trunc('day',t at time zone 'UTC') at time zone 'UTC' and notification_log_id is null);
    if v_count>=500 then return jsonb_build_object('code','daily_cap'); end if;
  end if;
  if a.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  update public.pilot_email_send_attempts set state='started',first_started_at=coalesce(first_started_at,clock_timestamp())
    where id=a.id and fence=p_fence and lease_until>clock_timestamp() returning * into a;
  if not found then return jsonb_build_object('code','stale_lease'); end if;
  return jsonb_build_object('code','started','attempt_id',a.id,'fence',a.fence,'lease_until',a.lease_until,
    'connection_id',c.id,'account_scope',c.account_scope,'credential_version',c.credential_version,'secret_ref',c.secret_ref,
    'payload',a.payload,'payload_json',a.payload::text,'payload_hash',a.payload_hash,'idempotency_key',a.idempotency_key,'first_started_at',a.first_started_at,'retry_until',a.first_started_at+interval '23 hours');
end $$;

create function public.pilot_email_confirm(p_attempt uuid,p_fence bigint,p_provider_email_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.pilot_email_send_attempts;
begin
  if p_provider_email_id is null or length(p_provider_email_id) not between 1 and 200 or p_provider_email_id ~ '[[:space:]]' then return jsonb_build_object('code','invalid_receipt'); end if;
  select * into a from public.pilot_email_send_attempts where id=p_attempt;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(a.user_id);
  select * into a from public.pilot_email_send_attempts where id=a.id for update;
  if a.fence is distinct from p_fence or a.lease_until is null or a.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  if a.state not in ('started','confirmed') then return jsonb_build_object('code','invalid_state'); end if;
  if a.provider_email_id is not null and a.provider_email_id<>p_provider_email_id then return jsonb_build_object('code','receipt_conflict'); end if;
  update public.pilot_email_send_attempts set state='confirmed',provider_email_id=p_provider_email_id,confirmed_at=coalesce(confirmed_at,clock_timestamp())
    where id=a.id and fence=p_fence and lease_until>clock_timestamp();
  if not found then return jsonb_build_object('code','stale_lease'); end if;
  return jsonb_build_object('code','confirmed','attempt_id',a.id,'provider_email_id',p_provider_email_id);
end $$;

create function public.pilot_email_finalize(p_attempt uuid,p_fence bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.pilot_email_send_attempts; v_conversation uuid; v_message uuid; v_log uuid;
begin
  select * into a from public.pilot_email_send_attempts where id=p_attempt;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(a.user_id);
  select * into a from public.pilot_email_send_attempts where id=a.id for update;
  if a.state='finalized' then return jsonb_build_object('code','finalized','attempt_id',a.id,'message_id',a.message_id,'notification_log_id',a.notification_log_id); end if;
  if a.fence is distinct from p_fence or a.lease_until is null or a.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  if a.state<>'confirmed' or a.provider_email_id is null then return jsonb_build_object('code','invalid_state'); end if;
  insert into public.conversations(user_id,customer_id) values(a.user_id,a.customer_id)
    on conflict(user_id,customer_id) do nothing;
  select id into v_conversation from public.conversations where user_id=a.user_id and customer_id=a.customer_id;
  insert into public.messages(user_id,conversation_id,customer_id,direction,channel,body,status,provider,provider_message_id,meta)
    values(a.user_id,v_conversation,a.customer_id,'outbound','email',a.payload->>'text','sent','resend',a.provider_email_id,
      jsonb_build_object('template','estimate_followup','quote_id',a.quote_id,'follow_up_number',a.step,'automated',true,'pilot_attempt_id',a.id,'pilot_connection_id',a.connection_id,'subject',a.payload->>'subject')) returning id into v_message;
  insert into public.notification_log(user_id,customer_id,channel,template,status,message_id,provider,provider_message_id)
    values(a.user_id,a.customer_id,'email','estimate_followup','sent',v_message,'resend',a.provider_email_id) returning id into v_log;
  update public.pilot_email_send_attempts set state='finalized',message_id=v_message,notification_log_id=v_log,lease_until=null,error_code=null
    where id=a.id and fence=p_fence and lease_until>clock_timestamp();
  -- A late lease expiry must roll back native writes, not return with them.
  if not found then raise exception 'pilot_lease_expired' using errcode='40001'; end if;
  update public.pilot_quote_followup_workflows w set state='completed' where id=a.workflow_id and state='approved'
    and not exists(select 1 from public.pilot_email_send_attempts x where x.workflow_id=w.id and x.state<>'finalized');
  return jsonb_build_object('code','finalized','attempt_id',a.id,'message_id',v_message,'notification_log_id',v_log);
end $$;

create function public.pilot_email_fail(p_attempt uuid,p_fence bigint,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.pilot_email_send_attempts;
begin
  if p_code is null or p_code not in ('provider_unknown','provider_refused','store_failed') then return jsonb_build_object('code','invalid_reason'); end if;
  select * into a from public.pilot_email_send_attempts where id=p_attempt;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(a.user_id);
  select * into a from public.pilot_email_send_attempts where id=a.id for update;
  if a.fence is distinct from p_fence or a.lease_until is null or a.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  if a.state not in ('leased','started','confirmed') then return jsonb_build_object('code','invalid_state'); end if;
  update public.pilot_email_send_attempts set lease_until=clock_timestamp(),error_code=p_code,
    state=case when provider_email_id is not null then 'confirmed' when p_code='provider_refused' then 'needs_review' else state end
    where id=a.id and fence=p_fence and lease_until>clock_timestamp();
  if not found then return jsonb_build_object('code','stale_lease'); end if;
  return jsonb_build_object('code','released');
end $$;

-- Webhook transport MUST verify the signature/canonical metadata before RPC.
-- This schema cannot verify a remote provider signature or retrieve content.
create function public.pilot_email_claim_event(p_connection uuid,p_event_id text,p_type text,p_provider_email_id text,p_route_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.pilot_email_connections; e public.pilot_email_webhook_events; a public.pilot_email_send_attempts;
begin
  select * into c from public.pilot_email_connections where id=p_connection;
  if not found then return jsonb_build_object('code','not_found'); end if;
  perform public._pilot_email_owner_lock(c.user_id);
  insert into public.pilot_email_webhook_events(connection_id,provider_event_id,event_type,provider_email_id,route_token)
    values(c.id,p_event_id,p_type,p_provider_email_id,p_route_token) on conflict(connection_id,provider_event_id) do nothing;
  select * into e from public.pilot_email_webhook_events where connection_id=c.id and provider_event_id=p_event_id for update;
  if e.event_type is distinct from p_type or e.provider_email_id is distinct from p_provider_email_id or e.route_token is distinct from p_route_token then return jsonb_build_object('code','event_conflict'); end if;
  if e.state='completed' then return jsonb_build_object('code','completed','event_id',e.id,'message_id',e.native_message_id); end if;
  if e.state='needs_review' then return jsonb_build_object('code','needs_review','event_id',e.id); end if;
  if e.lease_until>clock_timestamp() then return jsonb_build_object('code','busy','event_id',e.id); end if;
  if p_type='email.received' then
    select * into a from public.pilot_email_send_attempts where connection_id=c.id and reply_token=p_route_token;
    if not found then
      update public.pilot_email_webhook_events set state='needs_review',error_code='unknown_route' where id=e.id;
      return jsonb_build_object('code','needs_review','event_id',e.id); end if;
    -- Receipt of a valid routed response stops later dispatch immediately,
    -- including when content retrieval subsequently fails or sender mismatches.
    update public.pilot_quote_followup_workflows set state='held',hold_reason='reply_received',held_at=coalesce(held_at,clock_timestamp())
      where user_id=a.user_id and customer_id=a.customer_id and quote_id=a.quote_id;
  else
    select * into a from public.pilot_email_send_attempts where connection_id=c.id and provider_email_id=p_provider_email_id;
    if not found then
      update public.pilot_email_webhook_events set error_code='awaiting_send' where id=e.id;
      return jsonb_build_object('code','awaiting_send','event_id',e.id); end if;
  end if;
  update public.pilot_email_webhook_events set attempt_id=a.id,state='processing',fence=fence+1,lease_until=clock_timestamp()+interval '2 minutes',error_code=null where id=e.id returning * into e;
  return jsonb_build_object('code','claimed','event_id',e.id,'fence',e.fence,'lease_until',e.lease_until,'connection_id',c.id,'workflow_id',a.workflow_id,'attempt_id',a.id,'event_type',e.event_type,'provider_email_id',e.provider_email_id);
end $$;

create function public.pilot_email_finalize_event(p_event uuid,p_fence bigint,p_sender text default null,p_body text default null,p_occurred_at timestamptz default null,p_rfc_message_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.pilot_email_webhook_events; c public.pilot_email_connections; a public.pilot_email_send_attempts;
  prior public.pilot_email_webhook_events; w public.pilot_quote_followup_workflows;
  v_conversation uuid; v_message uuid; v_status text; v_rank integer; v_at timestamptz; v_old_opt_in boolean;
begin
  select * into e from public.pilot_email_webhook_events where id=p_event;
  if not found then return jsonb_build_object('code','not_found'); end if;
  select * into c from public.pilot_email_connections where id=e.connection_id;
  perform public._pilot_email_owner_lock(c.user_id);
  select * into e from public.pilot_email_webhook_events where id=e.id for update;
  if e.state='completed' then return jsonb_build_object('code','completed','event_id',e.id,'message_id',e.native_message_id); end if;
  if e.fence is distinct from p_fence or e.lease_until is null or e.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  if e.state<>'processing' or e.attempt_id is null then return jsonb_build_object('code','invalid_state'); end if;
  select * into a from public.pilot_email_send_attempts where id=e.attempt_id and connection_id=c.id for update;
  select * into w from public.pilot_quote_followup_workflows where id=a.workflow_id;
  if p_occurred_at is not null and not isfinite(p_occurred_at) then return jsonb_build_object('code','invalid_content'); end if;
  if e.event_type='email.received' then
    select * into prior from public.pilot_email_webhook_events where connection_id=c.id and provider_email_id=e.provider_email_id
      and event_type='email.received' and state='completed' and duplicate_of is null;
    if found then
      if prior.attempt_id<>a.id then
        update public.pilot_email_webhook_events set state='needs_review',error_code='metadata_mismatch',lease_until=null where id=e.id;
        return jsonb_build_object('code','needs_review'); end if;
      update public.pilot_email_webhook_events set state='completed',completed_at=clock_timestamp(),lease_until=null,native_message_id=prior.native_message_id,duplicate_of=prior.id where id=e.id;
      return jsonb_build_object('code','completed','event_id',e.id,'message_id',prior.native_message_id);
    end if;
    if p_sender is null or lower(p_sender)<>lower(w.recipient_email) then
      update public.pilot_email_webhook_events set state='needs_review',error_code='sender_mismatch',lease_until=null where id=e.id;
      update public.pilot_quote_followup_workflows set state='held',hold_reason='reply_review',held_at=coalesce(held_at,clock_timestamp()) where id=w.id;
      return jsonb_build_object('code','needs_review'); end if;
    if p_body is null or length(p_body) not between 1 and 30000 or (p_rfc_message_id is not null and (length(p_rfc_message_id)>998 or p_rfc_message_id ~ E'[\r\n]')) then return jsonb_build_object('code','invalid_content'); end if;
    -- Only an exact single-word opt-out after route+sender verification. Never
    -- interpret prose as acceptance, decline, consent restoration or a send.
    if lower(btrim(p_body))='unsubscribe' then
      select email_opt_in into v_old_opt_in from public.customers where user_id=a.user_id and id=a.customer_id for update;
      if v_old_opt_in then
        update public.customers set email_opt_in=false where user_id=a.user_id and id=a.customer_id;
        insert into public.consent_changes(user_id,customer_id,channel,old_value,new_value,source,changed_by)
          values(a.user_id,a.customer_id,'email',true,false,'email','customer email reply');
      end if;
    end if;
    insert into public.conversations(user_id,customer_id) values(a.user_id,a.customer_id) on conflict(user_id,customer_id) do nothing;
    select id into v_conversation from public.conversations where user_id=a.user_id and customer_id=a.customer_id;
    -- DB receipt time preserves native trigger ordering; provider time is meta.
    insert into public.messages(user_id,conversation_id,customer_id,direction,channel,body,status,provider,provider_message_id,meta)
      values(a.user_id,v_conversation,a.customer_id,'inbound','email',p_body,'received','resend',e.provider_email_id,
        jsonb_build_object('quote_id',a.quote_id,'pilot_attempt_id',a.id,'pilot_connection_id',c.id,'pilot_event_id',e.id,
          'provider_occurred_at',p_occurred_at,'rfc_message_id',p_rfc_message_id,'received_from',p_sender)) returning id into v_message;
  else
    if a.state<>'finalized' or a.message_id is null or a.notification_log_id is null then
      update public.pilot_email_webhook_events set state='pending',error_code='awaiting_send',lease_until=null where id=e.id;
      return jsonb_build_object('code','awaiting_send'); end if;
    v_status:=case e.event_type when 'email.sent' then 'sent' when 'email.delivered' then 'delivered' when 'email.delivery_delayed' then 'retrying'
      when 'email.opened' then 'opened' when 'email.clicked' then 'clicked' when 'email.bounced' then 'bounced' when 'email.complained' then 'spam' end;
    v_rank:=case v_status when 'retrying' then 1 when 'sent' then 2 when 'delivered' then 3 when 'opened' then 4 when 'clicked' then 5 when 'bounced' then 91 when 'spam' then 92 end;
    v_at:=coalesce(p_occurred_at,clock_timestamp());
    -- Exact native IDs and owner/customer/provider chain, never a global ID.
    perform 1 from public.messages where id=a.message_id and user_id=a.user_id and customer_id=a.customer_id and provider='resend' and provider_message_id=a.provider_email_id for update;
    if not found then raise exception 'pilot_native_missing' using errcode='23514'; end if;
    perform 1 from public.notification_log where id=a.notification_log_id and user_id=a.user_id and customer_id=a.customer_id and message_id=a.message_id and provider='resend' and provider_message_id=a.provider_email_id for update;
    if not found then raise exception 'pilot_native_missing' using errcode='23514'; end if;
    update public.messages set status=v_status,delivered_at=case when v_status='delivered' then v_at else delivered_at end where id=a.message_id
      and (case lower(coalesce(status,'')) when 'queued' then 1 when 'sending' then 1 when 'retrying' then 1 when 'sent' then 2 when 'delivered' then 3 when 'opened' then 4 when 'clicked' then 5 when 'failed' then 90 when 'undelivered' then 90 when 'bounced' then 91 when 'spam' then 92 else 0 end)<v_rank;
    update public.notification_log set status=v_status,delivered_at=case when v_status='delivered' then v_at else delivered_at end,opened_at=case when v_status='opened' then v_at else opened_at end where id=a.notification_log_id
      and (case lower(coalesce(status,'')) when 'queued' then 1 when 'sending' then 1 when 'retrying' then 1 when 'sent' then 2 when 'delivered' then 3 when 'opened' then 4 when 'clicked' then 5 when 'failed' then 90 when 'undelivered' then 90 when 'bounced' then 91 when 'spam' then 92 else 0 end)<v_rank;
    v_message:=a.message_id;
  end if;
  update public.pilot_email_webhook_events set state='completed',completed_at=clock_timestamp(),lease_until=null,native_message_id=v_message,error_code=null
    where id=e.id and fence=p_fence and lease_until>clock_timestamp();
  if not found then raise exception 'pilot_lease_expired' using errcode='40001'; end if;
  return jsonb_build_object('code','completed','event_id',e.id,'message_id',v_message);
end $$;

create function public.pilot_email_fail_event(p_event uuid,p_fence bigint,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.pilot_email_webhook_events; v_owner uuid;
begin
  if p_code is null or p_code not in ('content_unavailable','metadata_mismatch','store_failed') then return jsonb_build_object('code','invalid_reason'); end if;
  select * into e from public.pilot_email_webhook_events where id=p_event;
  if not found then return jsonb_build_object('code','not_found'); end if;
  select user_id into v_owner from public.pilot_email_connections where id=e.connection_id;
  perform public._pilot_email_owner_lock(v_owner);
  select * into e from public.pilot_email_webhook_events where id=e.id for update;
  if e.fence is distinct from p_fence or e.lease_until is null or e.lease_until<=clock_timestamp() then return jsonb_build_object('code','stale_lease'); end if;
  if e.state<>'processing' then return jsonb_build_object('code','invalid_state'); end if;
  update public.pilot_email_webhook_events set state=case when p_code='metadata_mismatch' then 'needs_review' else 'pending' end,error_code=p_code,lease_until=null
    where id=e.id and fence=p_fence and lease_until>clock_timestamp();
  if not found then return jsonb_build_object('code','stale_lease'); end if;
  return jsonb_build_object('code','released');
end $$;

-- Remove default PUBLIC execute, including private internal helpers. Only the
-- listed public entrypoints are callable by the trusted service role.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['_pilot_email_immutable','_pilot_email_owner_lock',
      'pilot_email_create_connection','pilot_email_set_connection_state','pilot_email_approve_workflow','pilot_email_hold_workflow',
      'pilot_email_claim','pilot_email_start','pilot_email_confirm','pilot_email_finalize','pilot_email_fail',
      'pilot_email_claim_event','pilot_email_finalize_event','pilot_email_fail_event']) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
    if left(r.proname,1)<>'_' then
      execute format('grant execute on function %s to service_role',r.signature);
    end if;
  end loop;
end $$;

commit;
