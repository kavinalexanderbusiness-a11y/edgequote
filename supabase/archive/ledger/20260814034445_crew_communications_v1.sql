-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034445
--   name    : crew_communications_v1
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- CREW COMMUNICATIONS V1 — the conversation attached to a visit.
-- Canonical file: supabase/RUN-2026-08-13-crew-messages.sql (read it for the
-- full reasoning; this is the same statements, applied).

create table if not exists public.crew_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  body        text not null
    constraint crew_messages_body_nonblank check (btrim(body) <> '')
    constraint crew_messages_body_length   check (char_length(body) <= 2000),
  author_kind text not null
    constraint crew_messages_author_kind check (author_kind in ('owner', 'crew', 'system')),
  author_technician_id uuid references public.technicians(id) on delete set null,
  author_name text not null,
  created_by  uuid,
  event_type  text,
  client_token text,
  created_at  timestamptz not null default now()
);

comment on table public.crew_messages is
  'CREW AUDIENCE (the business + the crew assigned to this visit). The conversation attached to one visit. Never customer-facing: no portal projection, no PDF, no public API selects it. Not a note — jobs.notes is the standing instruction; this is what was said and when.';
comment on column public.crew_messages.user_id is
  'The BUSINESS that owns the visit — the tenant boundary. Never the crew author''s own uid.';
comment on column public.crew_messages.event_type is
  'NULL = a person spoke. Non-null = a system event (schedule_changed). Do not dump every mutation here: a system event may only join a conversation that already exists.';

create index if not exists crew_messages_job_idx  on public.crew_messages (job_id, created_at);
create index if not exists crew_messages_user_idx on public.crew_messages (user_id, created_at desc);
create unique index if not exists crew_messages_client_token_key
  on public.crew_messages (job_id, created_by, client_token)
  where client_token is not null;

create table if not exists public.crew_message_reads (
  user_id      uuid not null references auth.users(id) on delete cascade,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  reader_id    uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (job_id, reader_id)
);

comment on table public.crew_message_reads is
  'High-water mark per (visit, reader). Unread is derived from it — deliberately NOT one row per message per user.';

create index if not exists crew_message_reads_reader_idx on public.crew_message_reads (reader_id);

create or replace function public.crew_message_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_tech uuid;
  v_name text;
begin
  if new.event_type is not null then
    new.author_kind          := 'system';
    new.author_technician_id := null;
    new.created_by           := null;
    new.author_name          := coalesce(nullif(btrim(new.author_name), ''), 'Schedule');
    return new;
  end if;

  if v_uid is null then
    raise exception 'a message needs a signed-in author' using errcode = '42501';
  end if;

  if v_uid = new.user_id then
    select coalesce(nullif(btrim(b.owner_name), ''), nullif(btrim(b.company_name), ''), 'Office')
      into v_name
      from public.business_settings b
     where b.user_id = new.user_id;
    new.author_kind          := 'owner';
    new.author_technician_id := null;
    new.created_by           := v_uid;
    new.author_name          := coalesce(v_name, 'Office');
    return new;
  end if;

  if public.crew_employer() is distinct from new.user_id then
    raise exception 'you cannot post to that visit' using errcode = '42501';
  end if;
  v_tech := public.crew_technician_id();
  select t.name into v_name from public.technicians t where t.id = v_tech;

  new.author_kind          := 'crew';
  new.author_technician_id := v_tech;
  new.created_by           := v_uid;
  new.author_name          := coalesce(nullif(btrim(v_name), ''), 'Crew');
  return new;
end
$$;

drop trigger if exists crew_message_identity on public.crew_messages;
create trigger crew_message_identity
  before insert on public.crew_messages
  for each row execute function public.crew_message_identity();

alter table public.crew_messages enable row level security;
drop policy if exists "crew_messages: owner all" on public.crew_messages;
create policy "crew_messages: owner all" on public.crew_messages
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid())
  );

alter table public.crew_message_reads enable row level security;
drop policy if exists "crew_message_reads: owner own" on public.crew_message_reads;
create policy "crew_message_reads: owner own" on public.crew_message_reads
  for all
  using (auth.uid() = user_id and auth.uid() = reader_id)
  with check (
    auth.uid() = user_id and auth.uid() = reader_id
    and exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid())
  );

grant select, insert, update, delete on public.crew_messages      to authenticated;
grant select, insert, update, delete on public.crew_message_reads to authenticated;

create or replace function public.crew_job_messages(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_uid      uuid := auth.uid();
  v_job      record;
  v_msgs     jsonb;
  v_high     timestamptz;
begin
  if v_employer is null or v_crew is null then
    return null;
  end if;

  select j.id, j.title, j.scheduled_date, j.status, c.name as customer_name
    into v_job
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
   where j.id = p_job_id and j.user_id = v_employer and j.crew_id = v_crew;

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
$$;

create or replace function public.crew_post_message(
  p_job_id       uuid,
  p_body         text,
  p_client_token text default null
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
  v_uid      uuid := auth.uid();
  v_job      uuid;
  v_body     text := btrim(coalesce(p_body, ''));
  v_row      public.crew_messages%rowtype;
begin
  if v_employer is null or v_crew is null then
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
   where j.id = p_job_id and j.user_id = v_employer and j.crew_id = v_crew;
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
$$;

create or replace function public.crew_message_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_uid      uuid := auth.uid();
begin
  if v_employer is null or v_crew is null then
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
                   and m.created_by is distinct from v_uid),
               'last_at', max(m.created_at),
               'last_author', (array_agg(m.author_name order by m.created_at desc))[1],
               'last_body',   (array_agg(m.body        order by m.created_at desc))[1]
             ) as row,
             count(*) filter (
               where m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                 and m.created_by is distinct from v_uid) as unread,
             max(m.created_at) as last_at
        from public.crew_messages m
        join public.jobs j on j.id = m.job_id
        left join public.customers c on c.id = j.customer_id
        left join public.crew_message_reads r on r.job_id = j.id and r.reader_id = v_uid
       where m.user_id = v_employer
         and j.user_id = v_employer
         and j.crew_id = v_crew
         and m.created_at > now() - interval '30 days'
       group by j.id, j.title, c.name, j.scheduled_date, j.status
    ) t
  ), '[]'::jsonb);
end
$$;

revoke execute on function public.crew_job_messages(uuid)        from public, anon;
revoke execute on function public.crew_post_message(uuid, text, text) from public, anon;
revoke execute on function public.crew_message_inbox()           from public, anon;
grant  execute on function public.crew_job_messages(uuid)        to authenticated;
grant  execute on function public.crew_post_message(uuid, text, text) to authenticated;
grant  execute on function public.crew_message_inbox()           to authenticated;
revoke execute on function public.crew_message_identity() from public, anon, authenticated;

create or replace function public.crew_message_schedule_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text;
begin
  if new.scheduled_date is not distinct from old.scheduled_date
     and new.start_time is not distinct from old.start_time then
    return new;
  end if;
  if not exists (select 1 from public.crew_messages m where m.job_id = new.id) then
    return new;
  end if;

  if new.scheduled_date is distinct from old.scheduled_date then
    v_body := 'Schedule changed — '
           || to_char(old.scheduled_date, 'Dy Mon FMDD')
           || ' → ' || to_char(new.scheduled_date, 'Dy Mon FMDD');
  else
    v_body := 'Start time changed — '
           || coalesce(to_char(date '2000-01-01' + old.start_time, 'FMHH12:MI AM'), 'no set time')
           || ' → ' || coalesce(to_char(date '2000-01-01' + new.start_time, 'FMHH12:MI AM'), 'no set time');
  end if;

  insert into public.crew_messages (user_id, job_id, body, author_kind, author_name, event_type)
  values (new.user_id, new.id, v_body, 'system', 'Schedule', 'schedule_changed');
  return new;
end
$$;

drop trigger if exists crew_message_schedule_event on public.jobs;
create trigger crew_message_schedule_event
  after update on public.jobs
  for each row execute function public.crew_message_schedule_event();

create or replace function public.crew_message_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job record;
begin
  if new.author_kind <> 'crew' then
    return new;
  end if;
  if exists (
    select 1 from public.notifications n
     where n.user_id = new.user_id and n.type = 'crew_message'
       and n.entity_id = new.job_id and n.read = false
  ) then
    return new;
  end if;

  select j.customer_id, j.title, c.name as customer_name
    into v_job
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
   where j.id = new.job_id;

  insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, href)
  values (
    new.user_id,
    'crew_message',
    new.author_name || ' — ' || coalesce(nullif(btrim(v_job.customer_name), ''), v_job.title, 'a visit'),
    left(new.body, 140),
    v_job.customer_id,
    'job',
    new.job_id,
    '/dashboard/schedule?job=' || new.job_id::text
  );
  return new;
end
$$;

drop trigger if exists crew_message_notify on public.crew_messages;
create trigger crew_message_notify
  after insert on public.crew_messages
  for each row execute function public.crew_message_notify();

alter table public.crew_media
  add column if not exists message_id uuid references public.crew_messages(id) on delete cascade;

create index if not exists crew_media_message_idx on public.crew_media (message_id)
  where message_id is not null;

comment on column public.crew_media.message_id is
  'NULL = office reference material for the visit (the original meaning). Set = an attachment on that crew_messages row. Deleting the message takes its attachments with it.';