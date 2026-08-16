-- ══ Session 67 — Worker availability + time off requests ════════════════════
--
-- WHAT THIS ADDS
--   1. worker_availability — a worker's standard week, one row per weekday.
--      No rows for a worker = "assumed generally available" (the assumption is
--      LABELLED in the product, never silently relied on). A weekday with no
--      available=true row, for a worker who HAS rows, is an unavailable day.
--   2. pto_entries.status — requested / approved / declined. Every existing row
--      defaults to 'approved' (the owner booked it; booking IS approval).
--      Planning subtracts APPROVED time off only. Declined rows are kept as a
--      record — they never block a later real booking (partial unique index).
--   3. Crew RPCs — a worker can see their own week + time off, set their own
--      weekly pattern, request time off, and cancel a still-pending request.
--      Same contract as every crew door: SECURITY DEFINER, typed parameters,
--      identity from the roster switches, NULL = not an active crew member.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   · No payroll PTO balances, no accrual — pto_entries stays the one ledger.
--   · No shift engine: one week pattern per worker, dated exceptions are
--     pto_entries rows. Nothing here schedules anyone.
--   · A worker request never asserts pay: is_paid=false, hourly_rate=null until
--     the owner decides at approval time (payroll truth stays owner-only).
--   · No crew RLS policy anywhere — crew access remains RPC-only.

-- ── 1. worker_availability ───────────────────────────────────────────────────

create table if not exists public.worker_availability (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  user_id uuid not null,
  technician_id uuid not null,
  weekday smallint not null,
  available boolean not null,
  start_time time,
  end_time time,
  constraint worker_availability_pkey primary key (id),
  constraint worker_availability_weekday_range check (weekday between 0 and 6),
  -- An available day states its window; an unavailable day states nothing.
  constraint worker_availability_window check (
    (available and start_time is not null and end_time is not null and end_time > start_time)
    or (not available and start_time is null and end_time is null)
  ),
  constraint worker_availability_one_per_weekday unique (technician_id, weekday),
  -- Composite tenancy FK, same shape as pto_entries_technician_same_owner:
  -- a row can only ever attach to a technician of the SAME business.
  constraint worker_availability_technician_same_owner
    foreign key (technician_id, user_id)
    references public.technicians (id, user_id) on delete cascade,
  constraint worker_availability_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade
);

create index if not exists worker_availability_user_idx
  on public.worker_availability (user_id);
create index if not exists worker_availability_tech_idx
  on public.worker_availability (technician_id, weekday);

create trigger worker_availability_updated_at
  before update on public.worker_availability
  for each row execute function public.set_updated_at();

alter table public.worker_availability enable row level security;

-- Owner-only, like technicians/pto_entries. ⛔ Deliberately NO crew policy:
-- a crew session reads its own pattern through crew_my_availability below.
create policy "worker_availability: select own" on public.worker_availability
  for select using (auth.uid() = user_id);
create policy "worker_availability: insert own" on public.worker_availability
  for insert with check (auth.uid() = user_id);
create policy "worker_availability: update own" on public.worker_availability
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "worker_availability: delete own" on public.worker_availability
  for delete using (auth.uid() = user_id);

revoke all on table public.worker_availability from public, anon, authenticated, service_role;
grant all on table public.worker_availability to authenticated;
grant all on table public.worker_availability to service_role;

comment on table public.worker_availability is
  'A worker''s standard week, one row per weekday (0=Sun…6=Sat). No rows for a worker = availability is ASSUMED, and surfaces must say so. A worker with rows is available only on weekdays holding an available=true row. Dated exceptions live in pto_entries.';

-- ── 2. pto_entries: requested / approved / declined ──────────────────────────

alter table public.pto_entries
  add column if not exists status text default 'approved' not null;
alter table public.pto_entries
  add column if not exists decided_at timestamptz;

do $$ begin
  alter table public.pto_entries
    add constraint pto_entries_status_known
    check (status in ('requested', 'approved', 'declined'));
exception when duplicate_object then null; end $$;

-- A DECLINED request is a record, not a booking — it must not block the owner
-- booking real time off on the same day. Rescope the duplicate rule to rows
-- that still count. (Same name, so the 23505 handling in the UI keeps working.)
alter table public.pto_entries drop constraint if exists pto_entries_one_per_day_kind;
create unique index if not exists pto_entries_one_per_day_kind
  on public.pto_entries (technician_id, date, kind)
  where status <> 'declined';

-- The owner's requests inbox.
create index if not exists pto_entries_requested_idx
  on public.pto_entries (user_id) where status = 'requested';

comment on column public.pto_entries.status is
  'requested = a worker asked and the owner has not decided; approved = counts against planning availability (every pre-existing row: the owner booked it); declined = kept as a record, never subtracts availability and never blocks a later booking.';

-- ── 3. Crew RPCs ─────────────────────────────────────────────────────────────
-- Contract per crew_day/crew_set_visit_status: DEFINER + roster switches.
-- Reads return NULL for a non-member (revoked ≠ error ≠ empty). Writes raise
-- 42501 for a non-member and return {ok:false, reason} for a refused input.

-- A worker's own week + time off. pto notes are deliberately NOT returned:
-- the notes column is the owner's bookkeeping field (the audience is the
-- office), and a worker's own request note travels one way, to the owner.
create or replace function public.crew_my_availability()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_tech     uuid := public.crew_technician_id();
begin
  if v_employer is null or v_tech is null then
    return null;
  end if;
  return jsonb_build_object(
    'pattern', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', w.weekday, 'available', w.available,
        'start_time', w.start_time, 'end_time', w.end_time
      ) order by w.weekday)
      from public.worker_availability w
      where w.technician_id = v_tech and w.user_id = v_employer
    ), '[]'::jsonb),
    'time_off', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'date', p.date, 'hours', p.hours,
        'kind', p.kind, 'status', p.status
      ) order by p.date desc)
      from public.pto_entries p
      where p.technician_id = v_tech and p.user_id = v_employer
        and p.date >= current_date - 60
    ), '[]'::jsonb)
  );
end
$function$;

-- Set ONE weekday of the caller's own pattern. Typed parameters — a worker can
-- only ever address their own technician row, resolved from the session.
create or replace function public.crew_set_day_availability(
  p_weekday smallint, p_available boolean,
  p_start_time time default null, p_end_time time default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_tech     uuid := public.crew_technician_id();
begin
  if v_employer is null or v_tech is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;
  if p_weekday is null or p_weekday < 0 or p_weekday > 6 then
    return jsonb_build_object('ok', false, 'reason', 'bad_weekday');
  end if;
  if p_available and (p_start_time is null or p_end_time is null or p_end_time <= p_start_time) then
    return jsonb_build_object('ok', false, 'reason', 'bad_window');
  end if;

  insert into public.worker_availability
    (user_id, technician_id, weekday, available, start_time, end_time)
  values (
    v_employer, v_tech, p_weekday, p_available,
    case when p_available then p_start_time end,
    case when p_available then p_end_time end
  )
  on conflict (technician_id, weekday) do update
    set available  = excluded.available,
        start_time = excluded.start_time,
        end_time   = excluded.end_time,
        updated_at = now();
  return jsonb_build_object('ok', true);
end
$function$;

-- Ask for time off. The request asserts NO payroll claim (unpaid, no rate) —
-- pay is the owner's decision at approval. The owner is notified once per
-- request row.
create or replace function public.crew_request_time_off(
  p_date date, p_hours numeric, p_kind text, p_note text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_tech     uuid := public.crew_technician_id();
  v_name     text;
  v_id       uuid;
begin
  if v_employer is null or v_tech is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;
  if p_date is null or p_date < current_date then
    return jsonb_build_object('ok', false, 'reason', 'past_date');
  end if;
  if p_hours is null or p_hours <= 0 or p_hours > 24 then
    return jsonb_build_object('ok', false, 'reason', 'bad_hours');
  end if;
  -- 'holiday' is owner-applied from the holiday calendar, never requested.
  if p_kind not in ('vacation', 'sick', 'personal', 'bereavement') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;

  begin
    insert into public.pto_entries
      (user_id, technician_id, date, hours, kind, is_paid, hourly_rate, notes, status)
    values (
      v_employer, v_tech, p_date, p_hours, p_kind,
      false, null, nullif(left(trim(coalesce(p_note, '')), 500), ''), 'requested'
    )
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already_booked');
  end;

  select t.name into v_name from public.technicians t where t.id = v_tech;
  insert into public.notifications (user_id, type, title, body, entity_type, entity_id, href)
  values (
    v_employer, 'time_off_requested', 'Time-off request',
    coalesce(v_name, 'A worker') || ' asked for ' || to_char(p_date, 'Mon FMDD') ||
      ' off (' || p_hours || ' h, ' || p_kind || ').',
    'pto_entry', v_id, '/dashboard/dispatch/time-off?tab=requests'
  );

  return jsonb_build_object('ok', true, 'id', v_id);
end
$function$;

-- Withdraw a request that is still pending. An APPROVED day is the owner's
-- record — it comes back through the office, not through a silent delete.
create or replace function public.crew_cancel_time_off(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_tech     uuid := public.crew_technician_id();
  v_gone     uuid;
begin
  if v_employer is null or v_tech is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;
  delete from public.pto_entries p
   where p.id = p_id and p.technician_id = v_tech and p.user_id = v_employer
     and p.status = 'requested'
  returning p.id into v_gone;
  if v_gone is null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  return jsonb_build_object('ok', true);
end
$function$;

-- Function grants — the crew door pattern: authenticated may knock (every
-- function fails closed on the roster switches), anon may not.
revoke all on function public.crew_my_availability() from public, anon, authenticated, service_role;
grant execute on function public.crew_my_availability() to authenticated;
grant execute on function public.crew_my_availability() to service_role;

revoke all on function public.crew_set_day_availability(p_weekday smallint, p_available boolean, p_start_time time, p_end_time time) from public, anon, authenticated, service_role;
grant execute on function public.crew_set_day_availability(p_weekday smallint, p_available boolean, p_start_time time, p_end_time time) to authenticated;
grant execute on function public.crew_set_day_availability(p_weekday smallint, p_available boolean, p_start_time time, p_end_time time) to service_role;

revoke all on function public.crew_request_time_off(p_date date, p_hours numeric, p_kind text, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.crew_request_time_off(p_date date, p_hours numeric, p_kind text, p_note text) to authenticated;
grant execute on function public.crew_request_time_off(p_date date, p_hours numeric, p_kind text, p_note text) to service_role;

revoke all on function public.crew_cancel_time_off(p_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.crew_cancel_time_off(p_id uuid) to authenticated;
grant execute on function public.crew_cancel_time_off(p_id uuid) to service_role;
