-- ════════════════════════════════════════════════════════════════════════════
-- CREW MODE — the foundation for authenticated employees
-- RUN-2026-08-07-crew-mode.sql
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT EXISTED BEFORE THIS FILE
-- EdgeQuote is single-owner by construction. All 85 public tables carry
-- `user_id` = the OWNER's auth uid, and ~300 RLS policies are the same four
-- lines: `auth.uid() = user_id` for select/insert/update/delete, PERMISSIVE, no
-- role restriction. `technicians` is the employee record (name/phone/email/role/
-- wage/status) but a technician was only ever a ROW — there was exactly one
-- auth user in the whole project. Non-owner access already had two precedents,
-- both token + SECURITY DEFINER RPC and neither authenticated: the customer
-- portal (get_portal_data) and public booking (submit_booking).
--
-- WHY NOT REWRITE THE TENANCY MODEL
-- Making employees first-class would mean rewriting every `auth.uid() = user_id`
-- policy across every table — the app's entire security boundary — to consult a
-- membership table. That is a tenancy rewrite with ~300 chances to widen owner
-- or customer access by accident. This file does the opposite: it does not touch
-- a single existing policy. Not one is dropped, widened or re-scoped.
--
-- THE MODEL
--   • `technicians` stays THE employee record; it gains a link to an auth user.
--     One auth user ↔ at most one technician (globally unique), so "which
--     business does this person work for" is always single-valued.
--   • Three STABLE SECURITY DEFINER helpers resolve identity from auth.uid():
--     crew_employer() / crew_crew_id() / crew_technician_id(). All three require
--     the technician to be LINKED, ACTIVE and NOT ARCHIVED — so the roster
--     controls that already exist (is_active, archived_at) are the off switch,
--     re-checked on every single query. No session to invalidate.
--   • current_app_role() is THE role answer for routing: 'owner' (has a
--     business_settings row — the same signal /dashboard already uses to
--     recognise a set-up account), else 'crew', else 'none'. Owner wins when
--     someone is both.
--   • ⭐ A CREW SESSION GETS NO TABLE ACCESS AT ALL. A crew RLS policy on `jobs`
--     was the obvious design, was written, and was removed after testing it over
--     real HTTP: RLS is ROW-level, so granting the row grants every COLUMN, and a
--     worker could ask PostgREST for `jobs?select=price`. Column privileges can't
--     fix it (a GRANT is role-wide and would restrict the owner too). So the crew
--     surface is RPCs only — exactly what the customer portal already is here.
--     Two doors, each naming its columns: crew_day()/crew_upcoming() to read,
--     crew_set_visit_status() to write.
--   • Writes still land on the CANONICAL row. crew_set_visit_status takes the
--     stamp as TYPED PARAMETERS (never a jsonb patch a client could stuff extra
--     columns into) and the values are computed by the SAME engine the owner's
--     board uses (lib/jobStatus.completionPatch). One definition of "done", two
--     audiences, no second job model.
--
-- SAFETY PROPERTIES
--   • Every function is SECURITY DEFINER with `search_path` PINNED — an unpinned
--     DEFINER function is hijackable by a hostile search_path — and each re-checks
--     authorization itself, because DEFINER runs past the RLS that would do it.
--   • auth.uid() is NULL for anon and for service-role/trigger-internal work, so
--     every crew predicate is FALSE by default. Fail closed: crew_day returns
--     NULL rather than an empty-but-plausible day.
--   • A technician with no crew_id sees nothing.
--   • Customer-portal and public-booking RPCs are untouched: they are token
--     functions that never call auth.uid().
--   • Supabase's default privileges grant EXECUTE on new public functions to
--     anon — revoked by name below, since `revoke ... from public` does not.
--
-- IDEMPOTENT. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Schema — three nullable columns on the existing employee record ───────
-- No new "who works here" table: technicians already IS that, and a rival table
-- would be a second answer to one question.
alter table public.technicians
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists invite_code text,
  add column if not exists invite_expires_at timestamptz;

comment on column public.technicians.auth_user_id is
  'The Supabase auth user this employee signs in as. NULL = records-only (no app access). Unique across the whole project: one login is one employee of one business.';
comment on column public.technicians.invite_code is
  'One-time join code the owner hands out. Cleared the moment it is redeemed.';

-- Partial-unique: many technicians may have NULL, but a linked auth user can
-- belong to exactly one, which is what keeps crew_employer() single-valued.
create unique index if not exists technicians_auth_user_id_key
  on public.technicians (auth_user_id) where auth_user_id is not null;
create unique index if not exists technicians_invite_code_key
  on public.technicians (invite_code) where invite_code is not null;

-- ── 2. Identity helpers ─────────────────────────────────────────────────────
-- The single source of truth for "who is this signed-in person at work".
-- Deactivation (is_active=false) and removal (archived_at) both revoke here, so
-- the roster the owner already manages IS the access-control surface.

create or replace function public.crew_employer()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.user_id
  from public.technicians t
  where t.auth_user_id = auth.uid()
    and t.is_active
    and t.archived_at is null
  limit 1
$$;

create or replace function public.crew_technician_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id
  from public.technicians t
  where t.auth_user_id = auth.uid()
    and t.is_active
    and t.archived_at is null
  limit 1
$$;

create or replace function public.crew_crew_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.crew_id
  from public.technicians t
  where t.auth_user_id = auth.uid()
    and t.is_active
    and t.archived_at is null
  limit 1
$$;

comment on function public.crew_employer() is
  'The owner user_id this signed-in employee works for, or NULL. NULL for anon, for owners, and for anyone deactivated/archived — every crew RLS predicate fails closed on it.';

-- THE routing answer. Owner wins when an account is somehow both, so an owner
-- can never be demoted into Crew Mode by a stray technician link.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null then 'none'
    when exists (select 1 from public.business_settings b where b.user_id = auth.uid()) then 'owner'
    when public.crew_employer() is not null then 'crew'
    else 'none'
  end
$$;

-- ⚠️ Supabase's DEFAULT PRIVILEGES grant EXECUTE on every new function in
-- `public` to anon/authenticated/service_role, and that default is applied at
-- CREATE time — so `revoke ... from public` does NOT remove it. Each grant has
-- to be revoked by name. None of these are exploitable by anon (every one starts
-- from auth.uid(), which is NULL, and returns null or raises), but nobody should
-- have to re-derive that for eleven functions.
--
-- The three identity helpers are INTERNAL: they are only ever called from inside
-- the other DEFINER functions, which run as their owner and need no grant. Left
-- callable, they would let any signed-in person ask the server who they work for.
revoke execute on function public.crew_employer() from public, anon, authenticated;
revoke execute on function public.crew_technician_id() from public, anon, authenticated;
revoke execute on function public.crew_crew_id() from public, anon, authenticated;
-- Routing needs a session in hand, so anon never calls it.
revoke execute on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated;

-- ── 3. Crew table access: NONE ──────────────────────────────────────────────
-- ⭐ THE decision this file turns on.
--
-- The obvious design is a crew RLS policy on `jobs` — and it was written, tried
-- against the live database over real HTTP, and REMOVED. RLS is ROW-level: being
-- granted the row grants every COLUMN on it, so a worker with a select policy
-- could ask PostgREST for `jobs?select=price` and read the revenue on their own
-- stops. crew_day() below is carefully column-limited, and a policy sitting
-- beside it undercuts the whole point. Column privileges can't rescue it either
-- — a GRANT is role-wide, so restricting `authenticated` restricts the OWNER too.
--
-- So a crew session gets no direct table grants whatsoever, and the crew surface
-- becomes what the customer portal already is in this codebase: RPCs only. Two
-- doors, each naming its own columns — crew_day()/crew_upcoming() to read,
-- crew_set_visit_status() to write.
--
-- Every existing `auth.uid() = user_id` policy is therefore untouched by this
-- migration. Not one of the ~300 is dropped, widened or re-scoped: the owner's
-- access is exactly what it was, and a crew member matches none of them.

drop policy if exists "jobs: crew reads assigned" on public.jobs;
drop policy if exists "jobs: crew updates assigned" on public.jobs;

-- ── 4. The column guard (belt and braces) ───────────────────────────────────
-- With no crew policy on `jobs`, nothing can currently reach this trigger — and
-- it is kept for exactly that reason. If a future change ever re-adds a crew
-- UPDATE policy (the obvious "improvement" someone will reach for), the writable
-- columns are still pinned and the mistake stays contained.
--
-- The field lifecycle a worker owns: status, and the timestamps that describe
-- it. Everything else — price, schedule, customer, crew assignment, the notes
-- the OWNER writes gate codes into — is rejected outright.
--
-- ⚠️ This fires on EVERY jobs UPDATE, including all of the owner's. It returns
-- immediately for anyone who is not an authenticated crew member: auth.uid() is
-- NULL for service-role and trigger-internal writes, and equals new.user_id for
-- the owner, so the owner path costs one comparison and can never raise.
create or replace function public.crew_job_field_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() = new.user_id then
    return new;                      -- service role, trigger internals, or the owner
  end if;
  if public.crew_employer() is null then
    return new;                      -- not a crew member — RLS already decided
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

  -- Cancelling is a business decision, not a field one. A worker who cannot
  -- finish a visit leaves it open for the office; they never delete the day.
  if new.status not in ('scheduled', 'in_progress', 'completed') then
    raise exception 'crew may not set a visit to %', new.status
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists crew_job_field_guard on public.jobs;
create trigger crew_job_field_guard
  before update on public.jobs
  for each row execute function public.crew_job_field_guard();

-- ── 5. The crew's read — one RPC, an explicit column list ───────────────────
-- Everything Crew Mode shows, for one day, in one round trip. A DEFINER
-- function rather than extra RLS policies precisely BECAUSE it can choose
-- columns: `customers` also holds consent flags, notes and lifetime value, and
-- `technicians` also holds hourly_wage. A crew SELECT policy on either would
-- hand those over with no way to hold them back.
--
-- Returns NULL when the caller is not an active linked crew member — so a
-- revoked employee gets nothing, not an empty-but-plausible day.
create or replace function public.crew_day(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
    'me', (
      select jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role, 'status', t.status)
      from public.technicians t where t.id = v_tech
    ),
    'crew', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'day_start', c.day_start)
      from public.crews c where c.id = v_crew and c.user_id = v_employer
    ),
    'business', (
      select jsonb_build_object('name', b.company_name, 'phone', b.phone, 'work_start_time', b.work_start_time)
      from public.business_settings b where b.user_id = v_employer
    ),
    -- Who else is on today's crew. Name and role only — never wages.
    'teammates', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role) order by t.name)
      from public.technicians t
      where t.user_id = v_employer and t.crew_id = v_crew
        and t.is_active and t.archived_at is null and t.id is distinct from v_tech
    ), '[]'::jsonb),
    -- The manager's written instructions for the day (added 2026-08-09, re-applied
    -- in place — this file stays THE definition). dispatch_notes is exactly the
    -- box the dispatch board labels "gate codes, yard reminders, weather calls":
    -- the day-wide note (crew_id null) and this crew's own note. Until now they
    -- rendered ONLY on the owner's board — the one screen a worker cannot open —
    -- so the gate code lived on the wrong side of the door. Body text only.
    'day_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id is null
    ),
    'crew_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id = v_crew
    ),
    -- The day's stops, in the order the route is run: the owner's manual
    -- sequence first (route_order), then committed time, then creation — the
    -- same precedence lib/crews.laneSequence uses on the dispatch board, so the
    -- worker's list and the dispatcher's lane can never disagree.
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
            -- The row version, so a crew write can carry the same optimistic-
            -- concurrency guard every other queued job patch does.
            'updated_at', j.updated_at,
            -- The access note (gate code, where to park) — the one thing you
            -- need before pulling into the driveway.
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
          -- Cancelled stops are INCLUDED (changed 2026-08-09, re-applied in
          -- place): a visit a worker saw at 8am and the office cancelled at
          -- 10am must move to a visible "cancelled — don't go" line, not
          -- silently vanish from the board. This is the SERVER's own record of
          -- the change — no client-side memory of "what was seen" to drift.
          -- crew_upcoming still excludes cancelled (Week counts real work),
          -- and crew_set_visit_status still refuses to touch a cancelled row.
      ) x
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$$;

revoke execute on function public.crew_day(date) from public, anon;
grant execute on function public.crew_day(date) to authenticated;

-- A worker's week — the same shape, condensed: how many stops each day, so
-- "what am I doing tomorrow" needs no second screen full of detail.
create or replace function public.crew_upcoming(p_from date, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
               -- DEFAULT_JOB_MIN (lib/route) — an unknown duration is 45 minutes
               -- of work everywhere else in the app, never zero.
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
$$;

revoke execute on function public.crew_upcoming(date, integer) from public, anon;
grant execute on function public.crew_upcoming(date, integer) to authenticated;

-- ── 5b. The crew's ONLY write ───────────────────────────────────────────────
-- Typed parameters, not a jsonb patch: a client cannot smuggle `price` or
-- `scheduled_date` through a parameter list that has no place to put them. The
-- VALUES are computed by lib/jobStatus.completionPatch on the client — the same
-- engine the owner's board uses — so "done" has one definition; this function
-- only applies it, and re-checks who is allowed to.
create or replace function public.crew_set_visit_status(
  p_job_id           uuid,
  p_status           text,
  p_base_updated_at  timestamptz,
  p_started_at       timestamptz default null,
  p_completed_at     timestamptz default null,
  p_actual_minutes   integer     default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_updated  timestamptz;
begin
  if v_employer is null or v_crew is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;
  -- The field lifecycle, and only it. 'cancelled' is a business decision: a
  -- worker who cannot finish leaves the visit open for the office.
  if p_status not in ('scheduled', 'in_progress', 'completed') then
    raise exception 'crew may not set a visit to %', p_status using errcode = '42501';
  end if;

  -- Assignment is re-checked HERE because this function is DEFINER and so runs
  -- past the RLS that would otherwise do it. Optimistic concurrency rides in the
  -- same predicate: if the office moved the visit while the phone held an old
  -- copy, nothing matches and the caller is told, rather than overwriting them.
  update public.jobs j
     set status         = p_status,
         started_at     = p_started_at,
         completed_at   = p_completed_at,
         actual_minutes = p_actual_minutes
   where j.id = p_job_id
     and j.user_id = v_employer
     and j.crew_id = v_crew
     and j.updated_at = p_base_updated_at
  returning j.updated_at into v_updated;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end
$$;

revoke execute on function public.crew_set_visit_status(uuid, text, timestamptz, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.crew_set_visit_status(uuid, text, timestamptz, timestamptz, timestamptz, integer) to authenticated;

-- ── 6. Linking an employee account ──────────────────────────────────────────
-- No service-role key is required for any of this (SUPABASE_SERVICE_ROLE_KEY is
-- not configured), and no email has to be deliverable. The owner mints a code
-- from the roster and hands it over; the employee redeems it once, signed in.

-- Owner side: mint or rotate a join code for one of THEIR technicians.
create or replace function public.crew_issue_invite(p_technician_id uuid, p_hours integer default 72)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_exp  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Ownership is checked here rather than trusted from the caller: this function
  -- is DEFINER and therefore bypasses the RLS that would otherwise do it.
  if not exists (
    select 1 from public.technicians t
    where t.id = p_technician_id and t.user_id = auth.uid() and t.archived_at is null
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;

  -- Unambiguous alphabet: no O/0, no I/1/L. This gets read aloud in a truck.
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                           1 + floor(random() * 31)::int, 1), '')
    into v_code
  from generate_series(1, 8);
  v_exp := now() + make_interval(hours => greatest(1, least(720, p_hours)));

  update public.technicians
     set invite_code = v_code, invite_expires_at = v_exp
   where id = p_technician_id;

  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end
$$;

-- Employee side: redeem it. One-time — the code is cleared on success.
create or replace function public.crew_redeem_invite(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tech public.technicians%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- An owner must not become their own employee: current_app_role() answers
  -- 'owner' first, so the link would be dead weight that only confuses routing.
  if exists (select 1 from public.business_settings b where b.user_id = auth.uid()) then
    raise exception 'this account owns a business — it cannot also join one as crew'
      using errcode = '42501';
  end if;
  -- One login is one employee. Re-linking would silently move somebody's work.
  if exists (select 1 from public.technicians t where t.auth_user_id = auth.uid()) then
    raise exception 'this account is already linked to an employee'
      using errcode = '42501';
  end if;

  select * into v_tech
  from public.technicians t
  where t.invite_code = upper(btrim(p_code))
  limit 1;

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
$$;

-- Owner side: take app access away. The roster switches (is_active/archived_at)
-- already revoke, because every helper re-checks them per query; this is the
-- explicit "unlink this login" for when someone leaves for good.
create or replace function public.crew_revoke_access(p_technician_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.technicians t
    where t.id = p_technician_id and t.user_id = auth.uid()
  ) then
    raise exception 'no such person on your roster' using errcode = '42501';
  end if;
  update public.technicians
     set auth_user_id = null, invite_code = null, invite_expires_at = null
   where id = p_technician_id;
  return jsonb_build_object('revoked', true);
end
$$;

revoke execute on function public.crew_issue_invite(uuid, integer) from public, anon;
revoke execute on function public.crew_redeem_invite(text) from public, anon;
revoke execute on function public.crew_revoke_access(uuid) from public, anon;
grant execute on function public.crew_issue_invite(uuid, integer) to authenticated;
grant execute on function public.crew_redeem_invite(text) to authenticated;
grant execute on function public.crew_revoke_access(uuid) to authenticated;
