-- ── Crews + Team Structure + Assignments V1 (Session 65) ─────────────────────
--
-- What this migration is, in one breath: the crew becomes a first-class TEAM
-- object (lead, protected history, tenant-safe references), a visit gains ONE
-- alternative assignee (a person instead of a crew — never both), and crew
-- membership gains an append-only history so yesterday's truth stops moving
-- when today's roster changes.
--
-- THE ASSIGNMENT MODEL (canonical, do not rival):
--   jobs.crew_id        → this crew runs the visit; members resolve at read time
--   jobs.technician_id  → exactly this person runs the visit
--   both NULL           → unassigned
--   both SET            → impossible (jobs_one_assignee CHECK)
-- One column pair, one meaning, no join table, no duplicate assignment truth.
--
-- WHY history and not a snapshot column: the failure being prevented is
-- "a worker joins Crew A tomorrow and is thereby recorded as having worked
-- Crew A's job last Tuesday". The clock rows (time_entries, job_work_sessions)
-- already keep WHAT happened; what moved under them was WHICH CREW a person
-- belonged to at that moment. technician_crew_history pins that, written only
-- by trigger, readable by the owner, deletable by nobody.

-- ── 1. Tenant-safe crew references ───────────────────────────────────────────
-- crews(id) was referenced by single-column FKs, so tenant A could point their
-- technician / visit / vehicle / note at tenant B's crew (RLS checks the ROW's
-- user_id, not what its foreign keys aim at). Same class of hole the
-- actual-cost-capture audit closed on job_line_items. Composite FKs close it.

-- Added conditionally rather than dropped-and-recreated: the composite foreign
-- keys below depend on this key, so a re-run that dropped it first would fail on
-- its own dependants.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crews_id_user_key' and conrelid = 'public.crews'::regclass
  ) then
    alter table public.crews add constraint crews_id_user_key unique (id, user_id);
  end if;
end
$$;

alter table public.technicians drop constraint if exists technicians_crew_id_fkey;
alter table public.technicians drop constraint if exists technicians_crew_same_owner;
alter table public.technicians add constraint technicians_crew_same_owner
  foreign key (crew_id, user_id) references public.crews(id, user_id) on delete set null (crew_id);

alter table public.jobs drop constraint if exists jobs_crew_id_fkey;
alter table public.jobs drop constraint if exists jobs_crew_same_owner;
alter table public.jobs add constraint jobs_crew_same_owner
  foreign key (crew_id, user_id) references public.crews(id, user_id) on delete set null (crew_id);

alter table public.equipment drop constraint if exists equipment_crew_id_fkey;
alter table public.equipment drop constraint if exists equipment_crew_same_owner;
alter table public.equipment add constraint equipment_crew_same_owner
  foreign key (crew_id, user_id) references public.crews(id, user_id) on delete set null (crew_id);

alter table public.dispatch_notes drop constraint if exists dispatch_notes_crew_id_fkey;
alter table public.dispatch_notes drop constraint if exists dispatch_notes_crew_same_owner;
alter table public.dispatch_notes add constraint dispatch_notes_crew_same_owner
  foreign key (crew_id, user_id) references public.crews(id, user_id) on delete cascade;

-- ── 2. Personal assignment: jobs.technician_id ───────────────────────────────

alter table public.jobs add column if not exists technician_id uuid;

alter table public.jobs drop constraint if exists jobs_technician_same_owner;
alter table public.jobs add constraint jobs_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

-- A visit has ONE assignee. A crew and a person at once is two answers to
-- "who is coming" — the double-assignment semantics this model refuses.
alter table public.jobs drop constraint if exists jobs_one_assignee;
alter table public.jobs add constraint jobs_one_assignee
  check (crew_id is null or technician_id is null);

create index if not exists jobs_technician_id_idx on public.jobs (technician_id);

comment on column public.jobs.technician_id is
  'Direct personal assignment: exactly this person runs the visit. Mutually exclusive with crew_id (jobs_one_assignee). NULL + NULL crew_id = unassigned.';
comment on column public.jobs.crew_id is
  'Which crew runs this visit; members resolve from technicians.crew_id at read time. Mutually exclusive with technician_id (jobs_one_assignee). NULL = no crew. Orthogonal to crew_size (headcount).';

-- Assigning NEW work to a deactivated crew or an off-roster person is a promise
-- nobody will keep. Existing rows keep their historical pointers untouched —
-- this fires only when the assignment itself changes.
CREATE OR REPLACE FUNCTION public.jobs_assignment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.crew_id is not null
     and (tg_op = 'INSERT' or new.crew_id is distinct from old.crew_id)
     and exists (select 1 from public.crews c where c.id = new.crew_id and not c.is_active) then
    raise exception 'that crew is deactivated — reactivate it or choose another'
      using errcode = '23514';
  end if;
  if new.technician_id is not null
     and (tg_op = 'INSERT' or new.technician_id is distinct from old.technician_id)
     and exists (
       select 1 from public.technicians t
       where t.id = new.technician_id and (not t.is_active or t.archived_at is not null)
     ) then
    raise exception 'that person is not on the active roster'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

revoke all on function public.jobs_assignment_guard() from public, anon, authenticated;

-- Every `create trigger`/`create policy` in this file is preceded by a drop, so
-- a half-applied run can be re-run to completion rather than needing to be
-- unpicked by hand. (Postgres has no `create trigger if not exists`.)
drop trigger if exists jobs_assignment_guard on public.jobs;
create trigger jobs_assignment_guard
  before insert or update of crew_id, technician_id on public.jobs
  for each row execute function public.jobs_assignment_guard();

-- ── 3. Crew lead (optional, honest) ──────────────────────────────────────────
-- A lead is a MEMBER wearing a hat, not a parallel management structure: the
-- trigger pair keeps the pointer consistent (must be an active member to become
-- lead; stops being lead the moment they leave the crew or the roster).

alter table public.crews add column if not exists lead_technician_id uuid;

alter table public.crews drop constraint if exists crews_lead_same_owner;
alter table public.crews add constraint crews_lead_same_owner
  foreign key (lead_technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (lead_technician_id);

comment on column public.crews.lead_technician_id is
  'Optional crew lead. Must be an active member of this crew (crews_lead_is_member); cleared automatically when they leave the crew or the roster.';

CREATE OR REPLACE FUNCTION public.crews_lead_is_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.lead_technician_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.technicians t
    where t.id = new.lead_technician_id
      and t.user_id = new.user_id
      and t.crew_id = new.id
      and t.is_active
      and t.archived_at is null
  ) then
    raise exception 'the crew lead must be an active member of this crew'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

revoke all on function public.crews_lead_is_member() from public, anon, authenticated;

drop trigger if exists crews_lead_is_member on public.crews;
create trigger crews_lead_is_member
  before insert or update of lead_technician_id on public.crews
  for each row execute function public.crews_lead_is_member();

CREATE OR REPLACE FUNCTION public.clear_crew_lead_on_departure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update public.crews c
     set lead_technician_id = null
   where c.user_id = new.user_id
     and c.lead_technician_id = new.id
     and (c.id is distinct from new.crew_id
          or not new.is_active
          or new.archived_at is not null);
  return new;
end
$function$;

revoke all on function public.clear_crew_lead_on_departure() from public, anon, authenticated;

drop trigger if exists technicians_clear_crew_lead on public.technicians;
create trigger technicians_clear_crew_lead
  after update of crew_id, is_active, archived_at on public.technicians
  for each row execute function public.clear_crew_lead_on_departure();

-- ── 4. Membership history: append-only, trigger-written ──────────────────────
-- Each row: "as of changed_at, this person's crew became crew_id" (NULL = no
-- crew). Written ONLY by the trigger below; no client role can insert, update
-- or delete a row (RLS grants the owner SELECT and nothing else). Past labour
-- attribution resolves membership AS OF the moment worked, from here.

create table if not exists public.technician_crew_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  technician_id uuid not null,
  crew_id       uuid,
  changed_at    timestamptz not null default now(),
  constraint technician_crew_history_technician_same_owner
    foreign key (technician_id, user_id) references public.technicians(id, user_id) on delete cascade,
  constraint technician_crew_history_crew_same_owner
    foreign key (crew_id, user_id) references public.crews(id, user_id)
);

create index if not exists technician_crew_history_tech_idx
  on public.technician_crew_history (technician_id, changed_at desc);
create index if not exists technician_crew_history_user_idx
  on public.technician_crew_history (user_id, changed_at desc);

comment on table public.technician_crew_history is
  'Append-only crew membership log, written only by trigger. Answers "which crew was this person on AT that time" so past attribution cannot be rewritten by moving someone today. Rows are never updated or deleted by any client role.';

alter table public.technician_crew_history enable row level security;

drop policy if exists "technician_crew_history: select own" on public.technician_crew_history;
create policy "technician_crew_history: select own" on public.technician_crew_history
  as permissive for select to public using (auth.uid() = user_id);

revoke all on table public.technician_crew_history from public;
revoke all on table public.technician_crew_history from anon;
revoke all on table public.technician_crew_history from authenticated;
grant select on table public.technician_crew_history to authenticated;
grant all on table public.technician_crew_history to service_role;

CREATE OR REPLACE FUNCTION public.record_technician_crew_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'INSERT' or old.crew_id is distinct from new.crew_id then
    insert into public.technician_crew_history (user_id, technician_id, crew_id)
    values (new.user_id, new.id, new.crew_id);
  end if;
  return new;
end
$function$;

revoke all on function public.record_technician_crew_history() from public, anon, authenticated;

drop trigger if exists technicians_crew_history on public.technicians;
create trigger technicians_crew_history
  after insert or update of crew_id on public.technicians
  for each row execute function public.record_technician_crew_history();

-- Seed: one opening row per existing technician, so every person has a known
-- membership from this moment on. Idempotent — re-running adds nothing.
insert into public.technician_crew_history (user_id, technician_id, crew_id)
select t.user_id, t.id, t.crew_id
from public.technicians t
where not exists (
  select 1 from public.technician_crew_history h where h.technician_id = t.id
);

-- ── 5. A crew with history deactivates; it does not delete ───────────────────
-- Deleting a crew SET NULLs jobs.crew_id — silently erasing who ran every past
-- visit. The history FK above would refuse anyway once members existed; this
-- trigger refuses FIRST, with a message the UI can show as instruction.

CREATE OR REPLACE FUNCTION public.crews_block_delete_with_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists (select 1 from public.jobs j where j.crew_id = old.id)
     or exists (select 1 from public.technician_crew_history h where h.crew_id = old.id)
  then
    raise exception 'this crew has history — deactivate it instead of deleting'
      using errcode = '23514';
  end if;
  return old;
end
$function$;

revoke all on function public.crews_block_delete_with_history() from public, anon, authenticated;

drop trigger if exists crews_block_delete_with_history on public.crews;
create trigger crews_block_delete_with_history
  before delete on public.crews
  for each row execute function public.crews_block_delete_with_history();

-- ── 6. THE crew-visibility predicate ─────────────────────────────────────────
-- One sentence, one place: a worker may see/act on a visit when it is assigned
-- to their crew, or to them personally. Every crew door below uses THIS
-- function — a door with its own predicate is a second assignment model.

-- ⚠️ NULL-SAFE ON PURPOSE. `j.crew_id = v_crew` is NULL — not false — when the
-- caller is on no crew, and a function that returns NULL from a boolean is a
-- trap waiting for the first caller that wraps it in `not`. Every branch is
-- coalesced so this answers true or false and nothing else. (A NULL would
-- currently still exclude the row in a WHERE, which is exactly why the bug
-- would have gone unnoticed until the day it did not.)
CREATE OR REPLACE FUNCTION public.crew_assignment_covers(j_crew uuid, j_technician uuid, v_crew uuid, v_tech uuid)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(j_crew = v_crew, false)
      or coalesce(j_technician = v_tech, false)
$function$;

revoke all on function public.crew_assignment_covers(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.crew_assignment_covers(uuid, uuid, uuid, uuid) to service_role;

-- ── 7. Crew doors re-pointed at the one predicate ────────────────────────────
-- Every function below is byte-for-byte the production definition except:
--   * v_tech is resolved alongside v_crew,
--   * the assignment predicate is crew_assignment_covers(...),
--   * a worker with NO crew but personal assignments is no longer invisible
--     (the old reads returned an empty-but-successful board for them, while the
--     writes raised — read and write now agree),
--   * crew_day stops carry 'personal' so the phone can say "assigned to you".

CREATE OR REPLACE FUNCTION public.crew_day(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    'teammates', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role) order by t.name)
      from public.technicians t
      where t.user_id = v_employer and t.crew_id = v_crew
        and t.is_active and t.archived_at is null and t.id is distinct from v_tech
    ), '[]'::jsonb),
    'day_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id is null
    ),
    'crew_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id = v_crew
    ),
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
            'completion_summary', j.completion_summary,
            'completion_issue', j.completion_issue,
            'personal', (j.technician_id is not null and j.technician_id = v_tech),
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
          and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
          and j.scheduled_date = p_date
      ) x
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_upcoming(p_from date, p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
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
        and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
        and j.status <> 'cancelled'
        and j.scheduled_date >= p_from
        and j.scheduled_date < p_from + greatest(1, least(31, p_days))
      group by j.scheduled_date
    ) g
  ), '[]'::jsonb);
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_set_visit_status(p_job_id uuid, p_status text, p_base_updated_at timestamp with time zone, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actual_minutes integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_updated  timestamptz;
begin
  if v_employer is null or v_tech is null then
    raise exception 'you are not on the active roster' using errcode = '42501';
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
     and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
     and j.updated_at = p_base_updated_at
  returning j.updated_at into v_updated;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_set_completion_record(p_job_id uuid, p_summary text DEFAULT NULL::text, p_issue text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_summary  text := nullif(btrim(coalesce(p_summary, '')), '');
  v_issue    text := nullif(btrim(coalesce(p_issue, '')), '');
  v_prev     text;
  v_job      record;
begin
  if v_employer is null or v_tech is null then
    raise exception 'you are not on the active roster' using errcode = '42501';
  end if;

  v_summary := left(v_summary, 500);
  v_issue   := left(v_issue, 500);

  select j.completion_issue into v_prev
    from public.jobs j
   where j.id = p_job_id and j.user_id = v_employer
     and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
     and j.status <> 'cancelled';

  update public.jobs j
     set completion_summary = v_summary,
         completion_issue   = v_issue
   where j.id = p_job_id
     and j.user_id = v_employer
     and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
     and j.status <> 'cancelled'
  returning j.id, j.title, j.customer_id into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  if v_issue is not null and v_prev is distinct from v_issue then
    insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, href)
    select v_employer, 'crew_visit_issue', 'Your crew flagged something',
           coalesce(v_job.title, 'A visit') || ': ' || v_issue,
           v_job.customer_id, 'job', v_job.id, '/dashboard/dispatch'
     where not exists (
       select 1 from public.notifications n
        where n.user_id = v_employer and n.type = 'crew_visit_issue' and n.entity_id = v_job.id
     );
  end if;

  return jsonb_build_object('ok', true);
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_job_messages(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_uid      uuid := auth.uid();
  v_job      record;
  v_msgs     jsonb;
  v_high     timestamptz;
begin
  if v_employer is null or v_tech is null then
    return null;
  end if;

  select j.id, j.title, j.scheduled_date, j.status, c.name as customer_name
    into v_job
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
   where j.id = p_job_id and j.user_id = v_employer
     and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech);

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select jsonb_agg(m.msg order by m.created_at), max(m.created_at)
    into v_msgs, v_high
    from (
      select jsonb_build_object(
               'id', x.id,
               'body', x.body,
               'author_kind', x.author_kind,
               'author_name', x.author_name,
               'author_technician_id', x.author_technician_id,
               'event_type', x.event_type,
               'mine', x.created_by is not distinct from v_uid,
               'created_at', x.created_at
             ) as msg,
             x.created_at
        from public.crew_messages x
       where x.job_id = v_job.id and x.user_id = v_employer
    ) m;

  if v_high is not null then
    insert into public.crew_message_reads (user_id, job_id, reader_id, last_read_at)
    values (v_employer, v_job.id, v_uid, v_high)
    on conflict (job_id, reader_id) do update
      set last_read_at = greatest(public.crew_message_reads.last_read_at, excluded.last_read_at);
  end if;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'title', v_job.title,
    'customer_name', v_job.customer_name,
    'scheduled_date', v_job.scheduled_date,
    'status', v_job.status,
    'messages', coalesce(v_msgs, '[]'::jsonb)
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_message_inbox()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_uid      uuid := auth.uid();
begin
  if v_employer is null or v_tech is null then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(t.row order by t.unread desc, t.last_at desc)
    from (
      select jsonb_build_object(
               'job_id', j.id,
               'title', j.title,
               'customer_name', c.name,
               'scheduled_date', j.scheduled_date,
               'status', j.status,
               'unread', count(*) filter (
                 where m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                   and m.created_by is distinct from v_uid
                   and m.author_kind <> 'system'),
               'last_at', max(m.created_at),
               'last_author', (array_agg(m.author_name order by m.created_at desc))[1],
               'last_body',   (array_agg(m.body        order by m.created_at desc))[1]
             ) as row,
             count(*) filter (
               where m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                 and m.created_by is distinct from v_uid
                 and m.author_kind <> 'system') as unread,
             max(m.created_at) as last_at
        from public.crew_messages m
        join public.jobs j on j.id = m.job_id
        left join public.customers c on c.id = j.customer_id
        left join public.crew_message_reads r on r.job_id = j.id and r.reader_id = v_uid
       where m.user_id = v_employer
         and j.user_id = v_employer
         and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
         and m.created_at > now() - interval '30 days'
       group by j.id, j.title, c.name, j.scheduled_date, j.status
    ) t
  ), '[]'::jsonb);
end
$function$;

CREATE OR REPLACE FUNCTION public.crew_post_message(p_job_id uuid, p_body text, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_uid      uuid := auth.uid();
  v_job      uuid;
  v_body     text := btrim(coalesce(p_body, ''));
  v_row      public.crew_messages%rowtype;
begin
  if v_employer is null or v_tech is null then
    return null;
  end if;
  if v_body = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if char_length(v_body) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;

  select j.id into v_job
    from public.jobs j
   where j.id = p_job_id and j.user_id = v_employer
     and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech);
  if v_job is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  insert into public.crew_messages (user_id, job_id, body, author_kind, author_name, client_token)
  values (v_employer, v_job, v_body, 'crew', 'Crew', nullif(btrim(coalesce(p_client_token, '')), ''))
  on conflict (job_id, created_by, client_token) where client_token is not null do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.crew_messages
     where job_id = v_job and created_by = v_uid
       and client_token = nullif(btrim(coalesce(p_client_token, '')), '')
     limit 1;
  end if;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'failed');
  end if;

  insert into public.crew_message_reads (user_id, job_id, reader_id, last_read_at)
  values (v_employer, v_job, v_uid, v_row.created_at)
  on conflict (job_id, reader_id) do update
    set last_read_at = greatest(public.crew_message_reads.last_read_at, excluded.last_read_at);

  return jsonb_build_object('ok', true, 'message', jsonb_build_object(
    'id', v_row.id,
    'body', v_row.body,
    'author_kind', v_row.author_kind,
    'author_name', v_row.author_name,
    'author_technician_id', v_row.author_technician_id,
    'event_type', v_row.event_type,
    'mine', true,
    'created_at', v_row.created_at
  ));
end
$function$;

-- The field-guard's protected set gains technician_id: a crew session can no
-- more reassign a visit to a person than it could move it between crews.
CREATE OR REPLACE FUNCTION public.crew_job_field_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
         new.technician_id, new.route_order, new.is_initial_visit)
     is distinct from
     row(old.user_id, old.customer_id, old.property_id, old.quote_id, old.recurrence_id,
         old.title, old.service_type, old.scheduled_date, old.start_time, old.end_time,
         old.duration_minutes, old.crew_size, old.price, old.notes, old.crew_id,
         old.technician_id, old.route_order, old.is_initial_visit)
  then
    raise exception 'crew may only change a visit''s status and its timestamps'
      using errcode = '42501';
  end if;

  if new.status not in ('scheduled', 'in_progress', 'completed') then
    raise exception 'crew may not set a visit to %', new.status using errcode = '42501';
  end if;

  return new;
end
$function$;
