-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260809075846
--   name    : crew_mode_foundation_2026_08_07
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- RUN-2026-08-07-crew-mode.sql — see supabase/RUN-2026-08-07-crew-mode.sql for the full rationale.
-- 1. Schema
alter table public.technicians
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists invite_code text,
  add column if not exists invite_expires_at timestamptz;

comment on column public.technicians.auth_user_id is
  'The Supabase auth user this employee signs in as. NULL = records-only (no app access). Unique across the whole project: one login is one employee of one business.';
comment on column public.technicians.invite_code is
  'One-time join code the owner hands out. Cleared the moment it is redeemed.';

create unique index if not exists technicians_auth_user_id_key
  on public.technicians (auth_user_id) where auth_user_id is not null;
create unique index if not exists technicians_invite_code_key
  on public.technicians (invite_code) where invite_code is not null;

-- 2. Identity helpers
create or replace function public.crew_employer()
returns uuid language sql stable security definer set search_path = public, pg_temp as $fn$
  select t.user_id from public.technicians t
  where t.auth_user_id = auth.uid() and t.is_active and t.archived_at is null limit 1
$fn$;

create or replace function public.crew_technician_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $fn$
  select t.id from public.technicians t
  where t.auth_user_id = auth.uid() and t.is_active and t.archived_at is null limit 1
$fn$;

create or replace function public.crew_crew_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $fn$
  select t.crew_id from public.technicians t
  where t.auth_user_id = auth.uid() and t.is_active and t.archived_at is null limit 1
$fn$;

comment on function public.crew_employer() is
  'The owner user_id this signed-in employee works for, or NULL. NULL for anon, for owners, and for anyone deactivated/archived — every crew RLS predicate fails closed on it.';

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = public, pg_temp as $fn$
  select case
    when auth.uid() is null then 'none'
    when exists (select 1 from public.business_settings b where b.user_id = auth.uid()) then 'owner'
    when public.crew_employer() is not null then 'crew'
    else 'none'
  end
$fn$;

revoke all on function public.crew_employer() from public;
revoke all on function public.crew_technician_id() from public;
revoke all on function public.crew_crew_id() from public;
revoke all on function public.current_app_role() from public;
grant execute on function public.crew_employer() to authenticated;
grant execute on function public.crew_technician_id() to authenticated;
grant execute on function public.crew_crew_id() to authenticated;
grant execute on function public.current_app_role() to authenticated, anon;

-- 3. Crew RLS on jobs only (additive)
drop policy if exists "jobs: crew reads assigned" on public.jobs;
create policy "jobs: crew reads assigned" on public.jobs
  for select using (
    (select public.crew_crew_id()) is not null
    and user_id = (select public.crew_employer())
    and crew_id = (select public.crew_crew_id())
  );

drop policy if exists "jobs: crew updates assigned" on public.jobs;
create policy "jobs: crew updates assigned" on public.jobs
  for update using (
    (select public.crew_crew_id()) is not null
    and user_id = (select public.crew_employer())
    and crew_id = (select public.crew_crew_id())
  ) with check (
    (select public.crew_crew_id()) is not null
    and user_id = (select public.crew_employer())
    and crew_id = (select public.crew_crew_id())
  );

-- 4. Column guard
create or replace function public.crew_job_field_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if auth.uid() is null or auth.uid() = new.user_id then
    return new;
  end if;
  if public.crew_employer() is null then
    return new;
  end if;

  if row(new.user_id, new.customer_id, new.property_id, new.quote_id, new.recurrence_id,
         new.title, new.service_type, new.scheduled_date, new.start_time, new.end_time,
         new.duration_minutes, new.crew_size, new.price, new.notes, new.crew_id,
         new.route_order, new.is_initial_visit)
     is distinct from
     row(old.user_id, old.customer_id, old.property_id, old.quote_id, old.recurrence_id,
         old.title, old.service_type, old.scheduled_date, old.start_time, old.end_time,
         old.duration_minutes, old.crew_size, old.price, old.notes, old.crew_id,
         old.route_order, old.is_initial_visit)
  then
    raise exception 'crew may only change a visit''s status and its timestamps'
      using errcode = '42501';
  end if;

  if new.status not in ('scheduled', 'in_progress', 'completed') then
    raise exception 'crew may not set a visit to %', new.status using errcode = '42501';
  end if;

  return new;
end
$fn$;

drop trigger if exists crew_job_field_guard on public.jobs;
create trigger crew_job_field_guard
  before update on public.jobs
  for each row execute function public.crew_job_field_guard();

-- 5. The crew read
create or replace function public.crew_day(p_date date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_out      jsonb;
begin
  if v_employer is null then
    return null;
  end if;

  select jsonb_build_object(
    'date', p_date,
    'me', (select jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role, 'status', t.status)
             from public.technicians t where t.id = v_tech),
    'crew', (select jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'day_start', c.day_start)
               from public.crews c where c.id = v_crew and c.user_id = v_employer),
    'business', (select jsonb_build_object('name', b.company_name, 'phone', b.phone, 'work_start_time', b.work_start_time)
                   from public.business_settings b where b.user_id = v_employer),
    'teammates', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role) order by t.name)
      from public.technicians t
      where t.user_id = v_employer and t.crew_id = v_crew
        and t.is_active and t.archived_at is null and t.id is distinct from v_tech
    ), '[]'::jsonb),
    'stops', coalesce((
      select jsonb_agg(x.stop order by x.route_rank, x.start_key, x.created_at)
      from (
        select
          jsonb_build_object(
            'id', j.id,
            'title', j.title,
            'service_type', j.service_type,
            'scheduled_date', j.scheduled_date,
            'start_time', j.start_time,
            'duration_minutes', j.duration_minutes,
            'crew_size', j.crew_size,
            'status', j.status,
            'started_at', j.started_at,
            'completed_at', j.completed_at,
            'actual_minutes', j.actual_minutes,
            'on_my_way_at', j.on_my_way_at,
            'route_order', j.route_order,
            'updated_at', j.updated_at,
            'notes', j.notes,
            'customer', case when cu.id is null then null else
              jsonb_build_object('name', cu.name, 'phone', cu.phone) end,
            'property', case when p.id is null then null else
              jsonb_build_object('address', p.address, 'lat', p.lat, 'lng', p.lng) end
          ) as stop,
          coalesce(j.route_order, 999999) as route_rank,
          coalesce(j.start_time::text, '99:99') as start_key,
          j.created_at
        from public.jobs j
        left join public.customers cu on cu.id = j.customer_id
        left join public.properties p on p.id = j.property_id
        where j.user_id = v_employer
          and j.crew_id = v_crew
          and j.scheduled_date = p_date
          and j.status <> 'cancelled'
      ) x
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$fn$;

revoke all on function public.crew_day(date) from public;
grant execute on function public.crew_day(date) to authenticated;

create or replace function public.crew_upcoming(p_from date, p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
begin
  if v_employer is null then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(g.day_summary order by g.day)
    from (
      select jsonb_build_object(
               'date', j.scheduled_date,
               'stops', count(*),
               'done', count(*) filter (where j.status = 'completed'),
               'minutes', coalesce(sum(coalesce(j.duration_minutes, 45)), 0)
             ) as day_summary,
             j.scheduled_date as day
      from public.jobs j
      where j.user_id = v_employer
        and j.crew_id = v_crew
        and j.status <> 'cancelled'
        and j.scheduled_date >= p_from
        and j.scheduled_date < p_from + greatest(1, least(31, p_days))
      group by j.scheduled_date
    ) g
  ), '[]'::jsonb);
end
$fn$;

revoke all on function public.crew_upcoming(date, integer) from public;
grant execute on function public.crew_upcoming(date, integer) to authenticated;

-- 6. Linking an employee account
create or replace function public.crew_issue_invite(p_technician_id uuid, p_hours integer default 72)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_code text;
  v_exp  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.technicians t
    where t.id = p_technician_id and t.user_id = auth.uid() and t.archived_at is null
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;

  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
    into v_code from generate_series(1, 8);
  v_exp := now() + make_interval(hours => greatest(1, least(720, p_hours)));

  update public.technicians
     set invite_code = v_code, invite_expires_at = v_exp
   where id = p_technician_id;

  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end
$fn$;

create or replace function public.crew_redeem_invite(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_tech public.technicians%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.business_settings b where b.user_id = auth.uid()) then
    raise exception 'this account owns a business — it cannot also join one as crew' using errcode = '42501';
  end if;
  if exists (select 1 from public.technicians t where t.auth_user_id = auth.uid()) then
    raise exception 'this account is already linked to an employee' using errcode = '42501';
  end if;

  select * into v_tech from public.technicians t
  where t.invite_code = upper(btrim(p_code)) limit 1;

  if v_tech.id is null then
    raise exception 'that code is not valid' using errcode = '42501';
  end if;
  if v_tech.invite_expires_at is null or v_tech.invite_expires_at < now() then
    raise exception 'that code has expired — ask for a new one' using errcode = '42501';
  end if;
  if v_tech.archived_at is not null or not v_tech.is_active then
    raise exception 'that code is not valid' using errcode = '42501';
  end if;
  if v_tech.auth_user_id is not null then
    raise exception 'that code has already been used' using errcode = '42501';
  end if;

  update public.technicians
     set auth_user_id = auth.uid(), invite_code = null, invite_expires_at = null
   where id = v_tech.id;

  return jsonb_build_object('technician_id', v_tech.id, 'name', v_tech.name);
end
$fn$;

create or replace function public.crew_revoke_access(p_technician_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.technicians t where t.id = p_technician_id and t.user_id = auth.uid()
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;
  update public.technicians
     set auth_user_id = null, invite_code = null, invite_expires_at = null
   where id = p_technician_id;
  return jsonb_build_object('revoked', true);
end
$fn$;

revoke all on function public.crew_issue_invite(uuid, integer) from public;
revoke all on function public.crew_redeem_invite(text) from public;
revoke all on function public.crew_revoke_access(uuid) from public;
grant execute on function public.crew_issue_invite(uuid, integer) to authenticated;
grant execute on function public.crew_redeem_invite(text) to authenticated;
grant execute on function public.crew_revoke_access(uuid) to authenticated;