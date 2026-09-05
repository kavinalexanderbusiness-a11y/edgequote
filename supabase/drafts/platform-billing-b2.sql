-- B2 OFFLINE DRAFT. Apply only after the separately reviewed B1 draft.
-- No replay migration, provider call, automatic provisioning or access change.
begin;

alter table public.platform_billing_accounts
  add column reconcile_event_id text,
  add column reconcile_attempt integer,
  add column reconcile_lease_until timestamptz,
  add constraint platform_billing_accounts_lease_check check (
    (reconcile_event_id is null and reconcile_attempt is null and reconcile_lease_until is null)
    or (reconcile_event_id is not null and reconcile_event_id ~ '[^[:space:]]'
      and reconcile_attempt is not null and reconcile_attempt > 0 and reconcile_lease_until is not null)
  );
-- The original owner-readable account projection excludes private event leases.
revoke select on public.platform_billing_accounts from authenticated;
grant select (id,user_id,stripe_account_id,livemode,stripe_customer_id,created_at,updated_at)
  on public.platform_billing_accounts to authenticated;

-- Leases span the provider read between RPCs. Row locks protect each transaction;
-- an advisory transaction lock alone cannot protect that gap. Always account -> event.
create function public.platform_billing_claim_event(
  p_stripe_account_id text, p_livemode boolean, p_event_id text,
  p_event_type text, p_event_created_at timestamptz,
  p_stripe_customer_id text, p_stripe_subscription_id text
) returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '1s'
as $$
declare
  a public.platform_billing_accounts%rowtype;
  e public.platform_billing_events%rowtype;
  has_account boolean;
  deadline timestamptz;
  required_ids jsonb;
begin
  if p_livemode is null or p_event_created_at is null
    or not coalesce(p_stripe_account_id ~ '[^[:space:]]', false)
    or not coalesce(p_event_id ~ '[^[:space:]]', false)
    or not coalesce(p_event_type ~ '[^[:space:]]', false)
    or not coalesce(p_stripe_customer_id ~ '[^[:space:]]', false)
    or not coalesce(p_stripe_subscription_id ~ '[^[:space:]]', false) then
    return jsonb_build_object('kind','retry','code','invalid_event');
  end if;
  select ba.* into a from public.platform_billing_accounts ba
    where ba.stripe_account_id=p_stripe_account_id and ba.livemode=p_livemode
      and ba.stripe_customer_id=p_stripe_customer_id
      and exists (select 1 from public.business_settings bs where bs.user_id=ba.user_id)
    for update of ba nowait;
  has_account := found;
  insert into public.platform_billing_events(stripe_account_id,livemode,event_id,event_type,event_created_at)
    values (p_stripe_account_id,p_livemode,p_event_id,p_event_type,p_event_created_at)
    on conflict do nothing;
  select be.* into e from public.platform_billing_events be
    where be.stripe_account_id=p_stripe_account_id and be.livemode=p_livemode and be.event_id=p_event_id
    for update nowait;
  if e.event_type is distinct from p_event_type or e.event_created_at is distinct from p_event_created_at then
    return jsonb_build_object('kind','retry','code','event_identity_mismatch');
  end if;
  if e.state in ('processed','ignored') then return jsonb_build_object('kind','already_completed','code','already_completed'); end if;
  -- Retain a received row for an unknown mapping; never pretend it was processed.
  if not has_account then return jsonb_build_object('kind','retry','code','unknown_account'); end if;
  if a.reconcile_lease_until > clock_timestamp()
    or (e.state='processing' and e.lease_until > clock_timestamp()) then
    return jsonb_build_object('kind','retry','code','busy');
  end if;
  deadline := clock_timestamp() + interval '60 seconds';
  update public.platform_billing_events set state='processing',attempt_count=attempt_count+1,
      lease_until=deadline,processed_at=null,last_error_code=null
    where stripe_account_id=p_stripe_account_id and livemode=p_livemode and event_id=p_event_id
    returning * into e;
  update public.platform_billing_accounts set reconcile_event_id=p_event_id,
    reconcile_attempt=e.attempt_count,reconcile_lease_until=deadline where id=a.id;
  select coalesce(jsonb_agg(sid order by sid),'[]'::jsonb) into required_ids from (
    select ps.stripe_subscription_id as sid from public.platform_subscriptions ps where ps.billing_account_id=a.id
      and ps.status in ('incomplete','trialing','active','past_due','unpaid','paused')
    union select p_stripe_subscription_id
  ) required;
  return jsonb_build_object('kind','claimed','billingAccountId',a.id,'userId',a.user_id,
    'attempt',e.attempt_count,'leaseUntil',deadline,'requiredSubscriptionIds',required_ids);
exception
  when lock_not_available or query_canceled then return jsonb_build_object('kind','retry','code','busy');
  when others then return jsonb_build_object('kind','retry','code','claim_failed');
end;
$$;

create function public.platform_billing_commit_event(
  p_billing_account_id uuid, p_stripe_account_id text, p_livemode boolean,
  p_stripe_customer_id text, p_event_id text, p_attempt integer,
  p_stripe_subscription_id text, p_subscriptions jsonb
) returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '1s'
as $$
declare
  a public.platform_billing_accounts%rowtype;
  e public.platform_billing_events%rowtype;
  item jsonb;
  field text;
  s record;
  affected integer;
begin
  select ba.* into a from public.platform_billing_accounts ba where ba.id=p_billing_account_id
    and ba.stripe_account_id=p_stripe_account_id and ba.livemode=p_livemode and ba.stripe_customer_id=p_stripe_customer_id
    and exists (select 1 from public.business_settings bs where bs.user_id=ba.user_id)
    for update of ba nowait;
  if not found then return jsonb_build_object('kind','retry','code','stale_attempt'); end if;
  select be.* into e from public.platform_billing_events be where be.stripe_account_id=p_stripe_account_id
    and be.livemode=p_livemode and be.event_id=p_event_id for update nowait;
  if not found or e.state<>'processing' or e.attempt_count is distinct from p_attempt
    or a.reconcile_event_id is distinct from p_event_id or a.reconcile_attempt is distinct from p_attempt
    or not coalesce(e.lease_until > clock_timestamp(),false)
    or not coalesce(a.reconcile_lease_until > clock_timestamp(),false) then
    return jsonb_build_object('kind','retry','code','stale_attempt');
  end if;
  if jsonb_typeof(p_subscriptions) is distinct from 'array' then return jsonb_build_object('kind','retry','code','invalid_snapshot'); end if;
  if jsonb_array_length(p_subscriptions) not between 1 and 1000 then return jsonb_build_object('kind','retry','code','invalid_snapshot'); end if;
  for item in select value from jsonb_array_elements(p_subscriptions) loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'stripe_subscription_id') is distinct from 'string'
      or jsonb_typeof(item->'stripe_customer_id') is distinct from 'string'
      or jsonb_typeof(item->'livemode') is distinct from 'boolean'
      or jsonb_typeof(item->'status') is distinct from 'string'
      or jsonb_typeof(item->'cancel_at_period_end') is distinct from 'boolean'
      or not coalesce(item->>'stripe_subscription_id' ~ '[^[:space:]]',false)
      or item->>'stripe_customer_id' is distinct from a.stripe_customer_id
      or (item->>'livemode')::boolean is distinct from a.livemode then
      return jsonb_build_object('kind','retry','code','invalid_snapshot');
    end if;
    foreach field in array array['stripe_price_id','trial_start','trial_end','current_period_start','current_period_end','cancel_at','canceled_at','ended_at'] loop
      if not (item ? field) or jsonb_typeof(item->field) not in ('string','null') then
        return jsonb_build_object('kind','retry','code','invalid_snapshot');
      end if;
    end loop;
  end loop;
  if (select count(*)<>count(distinct value->>'stripe_subscription_id') from jsonb_array_elements(p_subscriptions)) then
    return jsonb_build_object('kind','retry','code','invalid_snapshot');
  end if;
  if not exists (select 1 from jsonb_array_elements(p_subscriptions) x where x->>'stripe_subscription_id'=p_stripe_subscription_id)
    or exists (select 1 from public.platform_subscriptions ps where ps.billing_account_id=a.id
      and ps.status in ('incomplete','trialing','active','past_due','unpaid','paused')
      and not exists (select 1 from jsonb_array_elements(p_subscriptions) x where x->>'stripe_subscription_id'=ps.stripe_subscription_id)) then
    return jsonb_build_object('kind','retry','code','incomplete_snapshot');
  end if;
  -- Terminal rows release the nonterminal slot before a replacement is inserted.
  -- Distinct IDs always retain distinct history rows. A cross-account conflict
  -- affects zero rows and raises below; it never reassigns an existing mapping.
  for s in select * from jsonb_to_recordset(p_subscriptions) as x(
    stripe_subscription_id text,stripe_customer_id text,livemode boolean,stripe_price_id text,status text,
    trial_start timestamptz,trial_end timestamptz,current_period_start timestamptz,current_period_end timestamptz,
    cancel_at_period_end boolean,cancel_at timestamptz,canceled_at timestamptz,ended_at timestamptz
  ) order by case when status in ('canceled','incomplete_expired') then 0 else 1 end,stripe_subscription_id loop
    insert into public.platform_subscriptions as existing(
      billing_account_id,user_id,stripe_account_id,livemode,stripe_subscription_id,stripe_price_id,status,
      trial_start,trial_end,current_period_start,current_period_end,cancel_at_period_end,cancel_at,canceled_at,ended_at,last_synced_at
    ) values(a.id,a.user_id,a.stripe_account_id,a.livemode,s.stripe_subscription_id,s.stripe_price_id,s.status,
      s.trial_start,s.trial_end,s.current_period_start,s.current_period_end,s.cancel_at_period_end,s.cancel_at,s.canceled_at,s.ended_at,clock_timestamp())
    on conflict (stripe_account_id,livemode,stripe_subscription_id) do update set
      stripe_price_id=excluded.stripe_price_id,status=excluded.status,trial_start=excluded.trial_start,trial_end=excluded.trial_end,
      current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
      cancel_at_period_end=excluded.cancel_at_period_end,cancel_at=excluded.cancel_at,canceled_at=excluded.canceled_at,
      ended_at=excluded.ended_at,last_synced_at=excluded.last_synced_at
    where existing.billing_account_id=a.id and existing.user_id=a.user_id;
    get diagnostics affected = row_count;
    if affected<>1 then raise exception 'mapping_conflict'; end if;
  end loop;
  -- The exception block rolls back ALL writes above on a late failure/expiry.
  if not coalesce(e.lease_until > clock_timestamp(),false) or not coalesce(a.reconcile_lease_until > clock_timestamp(),false) then
    raise exception 'stale_attempt';
  end if;
  update public.platform_billing_events set state='processed',processed_at=clock_timestamp(),lease_until=null,last_error_code=null
    where stripe_account_id=p_stripe_account_id and livemode=p_livemode and event_id=p_event_id
      and state='processing' and attempt_count=p_attempt and lease_until > clock_timestamp();
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'stale_attempt'; end if;
  update public.platform_billing_accounts set reconcile_event_id=null,reconcile_attempt=null,reconcile_lease_until=null
    where id=a.id and reconcile_event_id=p_event_id and reconcile_attempt=p_attempt and reconcile_lease_until > clock_timestamp();
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'stale_attempt'; end if;
  return jsonb_build_object('kind','processed','code','processed');
exception
  when lock_not_available or query_canceled then return jsonb_build_object('kind','retry','code','busy');
  when others then return jsonb_build_object('kind','retry','code','commit_failed');
end;
$$;

create function public.platform_billing_fail_event(
  p_billing_account_id uuid, p_stripe_account_id text, p_livemode boolean,
  p_stripe_customer_id text, p_event_id text, p_attempt integer, p_error_code text
) returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '1s'
as $$
declare
  a public.platform_billing_accounts%rowtype;
  e public.platform_billing_events%rowtype;
  affected integer;
begin
  -- A short token-shaped secret can pass a regex. Persist only known constants.
  if p_error_code is null or p_error_code not in (
    'provider_read_failed','invalid_snapshot','store_commit_failed','store_response_invalid',
    'invalid_event','event_identity_mismatch','unknown_account','busy','claim_failed',
    'stale_attempt','incomplete_snapshot','commit_failed','invalid_error_code','attempt_failed','fail_failed'
  ) then
    return jsonb_build_object('kind','retry','code','invalid_error_code');
  end if;
  select ba.* into a from public.platform_billing_accounts ba where ba.id=p_billing_account_id
    and ba.stripe_account_id=p_stripe_account_id and ba.livemode=p_livemode and ba.stripe_customer_id=p_stripe_customer_id
    and exists (select 1 from public.business_settings bs where bs.user_id=ba.user_id)
    for update of ba nowait;
  if not found then return jsonb_build_object('kind','retry','code','stale_attempt'); end if;
  select be.* into e from public.platform_billing_events be where be.stripe_account_id=p_stripe_account_id
    and be.livemode=p_livemode and be.event_id=p_event_id for update nowait;
  if not found or e.state<>'processing' or e.attempt_count is distinct from p_attempt
    or a.reconcile_event_id is distinct from p_event_id or a.reconcile_attempt is distinct from p_attempt
    or not coalesce(e.lease_until > clock_timestamp(),false) or not coalesce(a.reconcile_lease_until > clock_timestamp(),false) then
    return jsonb_build_object('kind','retry','code','stale_attempt');
  end if;
  update public.platform_billing_events set state='failed',lease_until=null,processed_at=null,last_error_code=p_error_code
    where stripe_account_id=p_stripe_account_id and livemode=p_livemode and event_id=p_event_id
      and state='processing' and attempt_count=p_attempt and lease_until > clock_timestamp();
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'stale_attempt'; end if;
  update public.platform_billing_accounts set reconcile_event_id=null,reconcile_attempt=null,reconcile_lease_until=null
    where id=a.id and reconcile_event_id=p_event_id and reconcile_attempt=p_attempt and reconcile_lease_until > clock_timestamp();
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'stale_attempt'; end if;
  return jsonb_build_object('kind','retry','code','attempt_failed');
exception
  when lock_not_available or query_canceled then return jsonb_build_object('kind','retry','code','busy');
  when others then return jsonb_build_object('kind','retry','code','fail_failed');
end;
$$;

revoke all on function public.platform_billing_claim_event(text,boolean,text,text,timestamptz,text,text) from public,anon,authenticated,service_role;
revoke all on function public.platform_billing_commit_event(uuid,text,boolean,text,text,integer,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.platform_billing_fail_event(uuid,text,boolean,text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.platform_billing_claim_event(text,boolean,text,text,timestamptz,text,text) to service_role;
grant execute on function public.platform_billing_commit_event(uuid,text,boolean,text,text,integer,text,jsonb) to service_role;
grant execute on function public.platform_billing_fail_event(uuid,text,boolean,text,text,integer,text) to service_role;
commit;
