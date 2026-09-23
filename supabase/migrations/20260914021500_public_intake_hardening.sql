-- Public website intake rate limiting. Apply before deploying the matching
-- EdgeHQ server route so the endpoint can fail closed from its first request.

create table if not exists public.public_intake_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  ip_hash text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, ip_hash)
);

alter table public.public_intake_rate_limits enable row level security;
revoke all on public.public_intake_rate_limits from public, anon, authenticated;

create or replace function public.consume_public_intake_rate_limit(
  p_token text,
  p_ip_hash text,
  p_scope text default 'website-lead',
  p_limit integer default 8,
  p_window_seconds integer default 3600
) returns boolean
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_user uuid;
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$'
     or p_scope !~ '^[a-z0-9-]{3,40}$'
     or p_limit < 1 or p_limit > 100
     or p_window_seconds < 60 or p_window_seconds > 86400 then
    return false;
  end if;

  select user_id into v_user
  from public.business_settings
  where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;

  insert into public.public_intake_rate_limits
    (user_id, scope, ip_hash, window_started_at, request_count, updated_at)
  values (v_user, p_scope, p_ip_hash, v_now, 1, v_now)
  on conflict (user_id, scope, ip_hash) do update
    set window_started_at = case
          when public.public_intake_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds)
          then v_now else public.public_intake_rate_limits.window_started_at end,
        request_count = case
          when public.public_intake_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds)
          then 1 else public.public_intake_rate_limits.request_count + 1 end,
        updated_at = v_now
  returning request_count into v_count;

  delete from public.public_intake_rate_limits
  where updated_at < v_now - interval '2 days';
  return v_count <= p_limit;
end;
$function$;

revoke all on function public.consume_public_intake_rate_limit(text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_public_intake_rate_limit(text,text,text,integer,integer) to service_role;

comment on table public.public_intake_rate_limits is
  'Server-only hashed-IP counters for public website and booking intake abuse protection.';
