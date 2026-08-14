-- ══════════════════════════════════════════════════════════════════════════════
-- CREW COMMUNICATIONS V1 — the conversation attached to a visit
--
-- ⭐ WHAT THIS IS, IN ONE SENTENCE
-- A durable, tenant-scoped, crew-audience conversation hanging off ONE `jobs`
-- row (a `jobs` row IS a visit — see lib/vocabulary), readable by the business
-- and by the crew that visit is assigned to, and by nobody else, ever.
--
-- ⭐⭐ WHY THIS IS NOT A SECOND NOTES SYSTEM
-- Session 35 (RUN-2026-08-11-scoped-notes-crew-media.sql) settled that the
-- AUDIENCE OF TEXT IS A PROPERTY OF THE COLUMN. This file does not weaken that
-- and does not compete with it. It adds the OTHER half of a distinction the
-- product did not have a word for yet:
--
--   A NOTE is a STANDING FACT about the work.       jobs.notes
--     "Gate code 1942." "Don't prune the lilac."
--     Edited in place. Always current. No author, because the answer is the
--     same whoever wrote it. Read BEFORE you pull into the driveway.
--     ⛔ A note must never become a transcript: appending "…and now 1943" to a
--     gate code leaves the worker reading history to find the truth.
--
--   A MESSAGE is an UTTERANCE AT A MOMENT.          crew_messages (this file)
--     "I'm running 20 minutes late." "Approved — grab another."
--     Appended, never edited. Has an author and a time, because WHO said it and
--     WHEN is most of the meaning. Read as a sequence.
--     ⛔ A message must never become a note: "gate code 1942" said once in chat
--     is buried by the twentieth reply, and the next visit's crew never sees it.
--
-- The test, when you are unsure which one a new field is: **can it be answered
-- correctly without knowing who said it?** Yes → note. No → message.
--
-- ⭐ THE TABLE IS THE AUDIENCE — the crew_media precedent, deliberately reused.
-- There is NO `visibility` column here and there must never be one. Everything
-- in crew_messages is internal: the business and the assigned crew. A customer
-- does not read it after completion, on the PDF, in the portal, or ever. That is
-- enforced by get_portal_data naming its columns (crew_messages appears in it
-- NOWHERE) and asserted by verify:scoped-notes + verify:crew-messages.
--
-- ⭐ CREW REACH THIS THROUGH RPCs ONLY — Crew Mode's founding rule, unchanged.
-- A crew session holds NO table grants (RUN-2026-08-07-crew-mode.sql §3: an RLS
-- policy is ROW-level, so granting the row grants every column). So there is
-- deliberately NO crew policy on either table below. Three DEFINER doors, each
-- naming its own columns and re-proving assignment:
--     crew_job_messages(job)                 read one conversation + mark read
--     crew_post_message(job, body, token)    say one thing, exactly once
--     crew_message_inbox()                   what is waiting for me, and where
--
-- IDEMPOTENT. Safe to re-run. Contains one `create table if not exists` and one
-- `create policy` per table (dropped first), so re-running is a no-op.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The conversation ─────────────────────────────────────────────────────
-- One row per thing said. Ordered by created_at; there are no threads, because a
-- visit's conversation is short and linear and a reply-to would buy nesting
-- nobody asked for at the cost of an ordering nobody can predict on a phone.
create table if not exists public.crew_messages (
  id          uuid primary key default gen_random_uuid(),
  -- THE TENANT. The business that owns this visit — never the crew member's own
  -- uid, even when a crew member wrote the message. Every policy, every RPC and
  -- every index starts here.
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- THE VISIT. Cascade: deleting a visit takes its conversation with it rather
  -- than stranding messages pointing at work that no longer exists.
  job_id      uuid not null references public.jobs(id) on delete cascade,

  body        text not null
    constraint crew_messages_body_nonblank check (btrim(body) <> '')
    constraint crew_messages_body_length   check (char_length(body) <= 2000),

  -- ⭐ IDENTITY IS DERIVED, NEVER ACCEPTED. Every column below is overwritten by
  -- crew_message_identity() from auth.uid() before the row lands, so a client
  -- cannot post as somebody else. They are stored rather than joined because a
  -- transcript must stay true: "Jake said this at 9:20" does not stop being true
  -- when Jake leaves the roster and his row is archived.
  author_kind text not null
    constraint crew_messages_author_kind check (author_kind in ('owner', 'crew', 'system')),
  author_technician_id uuid references public.technicians(id) on delete set null,
  author_name text not null,
  created_by  uuid,                    -- the writer's auth uid; NULL for system events

  -- NULL means a person said it. Non-null names a SYSTEM EVENT the product
  -- generated (see §6) — kept in the same stream because "the visit moved to
  -- Wednesday" is part of the conversation, not a footnote beside it.
  event_type  text,

  -- ⭐ THE DOUBLE-TAP GUARD. The client mints this before the first attempt and
  -- reuses it on every retry, so a flaky tether cannot turn one thing said into
  -- two things said. Unique per (visit, writer) below.
  client_token text,

  created_at  timestamptz not null default now()
);

comment on table public.crew_messages is
  'CREW AUDIENCE (the business + the crew assigned to this visit). The conversation attached to one visit. ⛔ Never customer-facing: no portal projection, no PDF, no public API selects it. ⛔ Not a note — jobs.notes is the standing instruction; this is what was said and when.';
comment on column public.crew_messages.user_id is
  'The BUSINESS that owns the visit — the tenant boundary. Never the crew author''s own uid.';
comment on column public.crew_messages.event_type is
  'NULL = a person spoke. Non-null = a system event (schedule_changed). ⛔ Do not dump every mutation here: a system event may only join a conversation that already exists.';

-- One conversation read in order, and one tenant's whole stream newest-first
-- (the owner's unread roll-up). Nothing here is queried by author.
create index if not exists crew_messages_job_idx  on public.crew_messages (job_id, created_at);
create index if not exists crew_messages_user_idx on public.crew_messages (user_id, created_at desc);

-- ⭐ Exactly-once per (visit, writer, token). Partial, because system events and
-- any future server-side writer legitimately carry no token — and a NULL token
-- must never collide with another NULL token.
create unique index if not exists crew_messages_client_token_key
  on public.crew_messages (job_id, created_by, client_token)
  where client_token is not null;

-- ── 2. Read state — ONE ROW PER (VISIT, READER), NOT PER MESSAGE ────────────
-- A per-message receipt table costs rows(messages × members) and buys a feature
-- nobody asked for (who has seen which line). What a crew conversation actually
-- needs is "is there anything here I haven't seen", and a single high-water mark
-- answers that exactly, in one row, forever.
--
-- ⭐ Unread is therefore DERIVED, never stored: a message is unread to me if it
-- is newer than my mark AND I did not write it. There is no counter to drift out
-- of step with the messages it counts.
create table if not exists public.crew_message_reads (
  -- The tenant, carried so this table can be swept and audited by business like
  -- every other table here — never used to decide who may read what.
  user_id      uuid not null references auth.users(id) on delete cascade,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  reader_id    uuid not null,                              -- an auth uid (owner or crew)
  last_read_at timestamptz not null default now(),
  primary key (job_id, reader_id)
);

comment on table public.crew_message_reads is
  'High-water mark per (visit, reader). Unread is derived from it — deliberately NOT one row per message per user.';

create index if not exists crew_message_reads_reader_idx on public.crew_message_reads (reader_id);

-- ── 3. Identity, decided by the database ────────────────────────────────────
-- ⭐⭐ THE FORGERY GUARD. Whoever writes the row — the owner's browser through
-- RLS, a crew phone through the DEFINER RPC, or a trigger — the author columns
-- are computed HERE from auth.uid(). A client that sends author_name 'Jake' gets
-- its own name back. This is the reason the owner's insert can stay a plain
-- table write with no route in front of it.
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
  -- A system event names no person. It is generated by the triggers in §6, which
  -- run inside somebody's transaction (the owner rescheduling, or a service-role
  -- automation with no auth.uid() at all), so it must not require a session.
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

  -- The owner of the tenant. Their display name is the one the business already
  -- goes by; 'Office' is the generic fallback, because this product serves
  -- plumbers, cleaners and painters as readily as landscapers.
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

  -- Otherwise the only writer who may attach a message to this business is one
  -- of its ACTIVE crew members — the roster switches, re-asked here, exactly as
  -- crew_day() asks them. A deactivated worker fails on this line with an
  -- unexpired JWT in hand.
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

-- ── 4. Owner access: RLS, in the shape all ~300 other policies use ──────────
-- ⛔ NO CREW POLICY, ON PURPOSE. Crew Mode's founding rule: a crew session has
-- no table grants at all, so a worker matches none of these and reaches the
-- conversation only through the RPCs in §5, which prove assignment first.
--
-- ⭐ THE `with check` DOES MORE THAN MIRROR THE `using`. It also requires that
-- the VISIT belongs to the same business — so a message cannot be attached to
-- another tenant's job even by a caller who owns the row they are writing. That
-- is the cross-tenant write closed at the database, not in a route.
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

-- ⚠️⚠️ READ THE ACL BACK, DO NOT ASSUME IT. Supabase's ALTER DEFAULT PRIVILEGES
-- grants anon full DML on every new table in `public` AT CREATE TIME — verified
-- live on these two the moment they existed, with no grant written anywhere.
-- Every other table here sits the same way and is held by RLS alone, which is
-- sound (anon's auth.uid() is NULL, so no policy below can match). These two
-- have ZERO anon code path — the portal RPC is SECURITY DEFINER and runs as its
-- owner, so it needs no grant from the caller — which makes the grant pure
-- surface. Closing it costs nothing and means a future policy mistake, or an
-- RLS toggle, is not the only thing standing between anon and a gate code.
revoke all on public.crew_messages      from anon;
revoke all on public.crew_message_reads from anon;

-- ── 5. The crew's three doors ───────────────────────────────────────────────
-- Each one asks the SAME four questions /api/crew/media asks, in SQL:
--   1. is there a session                       (auth.uid(), via the helpers)
--   2. is this person an ACTIVE linked crew member  (crew_employer())
--   3. are they on a crew                       (crew_crew_id())
--   4. is this visit THEIR crew's work          (j.user_id + j.crew_id)
-- Returning NULL from a read means (2) failed — access revoked — and the client
-- must render that differently from an error, which is a different fact again.
-- (lib/crewAccess's three-outcome rule; folding them is how a worker in a dead
-- zone gets told they were fired.)

-- 5a. ONE conversation, and opening it marks it read.
--
-- ⭐ WHY READ-MARKING LIVES HERE AND NOT IN A SECOND CALL. "Opening the
-- conversation is what marks it read" is the only unread rule a person can
-- predict without being taught one, and putting the stamp in the same statement
-- that returns the messages makes it impossible for the two to disagree — there
-- is no window where a worker has read a message the server thinks is unread.
-- The mark is taken from the NEWEST MESSAGE RETURNED, not now(): a message that
-- lands one millisecond after this snapshot must still count as unread.
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
    return null;                       -- revoked: not an active crew member
  end if;

  -- ⭐ The client names a VISIT and nothing else. There is no parameter that
  -- could widen this: a job id copied from another business, or from another
  -- crew's board, matches nothing and is answered identically to a typo.
  -- Cancelled is NOT excluded, deliberately — "the office killed this at 10am
  -- and I'm already in the driveway" is exactly the thing a worker needs to be
  -- able to say. Talking about a visit is not working on one; the doors that
  -- MUTATE the work record (crew_set_visit_status, /api/crew/photos) still
  -- refuse a cancelled row.
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
               -- Whether THIS reader wrote it, answered by the server so the
               -- client never has to compare uids it should not be handling.
               'mine', x.created_by is not distinct from v_uid,
               'created_at', x.created_at
             ) as msg,
             x.created_at
        from public.crew_messages x
       where x.job_id = v_job.id and x.user_id = v_employer
    ) m;

  -- The high-water mark, from the snapshot just returned.
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

-- 5b. Say one thing, exactly once.
--
-- ⭐ THE TOKEN IS THE WHOLE ANTI-DUPLICATE STORY. A double tap, an impatient
-- retry and a request that succeeded on the server but died on the way back all
-- arrive here carrying the SAME token, and all three get the SAME row back —
-- `on conflict do nothing` then re-select. The client cannot tell a first send
-- from a replay, which is the point: it never has to.
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
    return null;                       -- revoked
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

  -- Conflict → this exact send already landed. Return the row that landed, not
  -- an error: the caller asked for the message to exist, and it does.
  if v_row.id is null then
    select * into v_row from public.crew_messages
     where job_id = v_job and created_by = v_uid
       and client_token = nullif(btrim(coalesce(p_client_token, '')), '')
     limit 1;
  end if;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'failed');
  end if;

  -- Your own message is not unread to you.
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

-- 5c. What is waiting for me, and which visit it is about.
--
-- ⭐ THIS IS AN INBOX OF VISITS, NOT A LIST OF CHANNELS. Every row names the work
-- it belongs to, because "Jake: need another bag" is unanswerable without it. A
-- visit with no conversation is not in here at all — there are no empty threads
-- to scroll past, and nothing is ever "created" by opening it.
--
-- Windowed to the last 30 days of talk so a season of finished visits does not
-- accumulate into a screen nobody can read on a phone.
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
    return null;                       -- revoked
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
               -- ⭐ UNREAD ABOVE IS ONE RULE, SPELLED THE SAME IN THREE PLACES
               -- (here, lib/crewMessages.unreadCount, and loadOwnerUnread): a
               -- PERSON'S words are unread; a system line is context. A system
               -- event has no author, so counting it would badge the owner for
               -- their own reschedule — and the crew already learn a move from
               -- their Today/Week board, which is server truth. The system line
               -- exists to keep the TRANSCRIPT honest, not to summon anybody.
               -- The newest line, and who said it — enough to decide whether to
               -- open it without opening it.
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

-- ⚠️ Supabase's DEFAULT PRIVILEGES grant EXECUTE on every new public function to
-- anon/authenticated at CREATE time, and `revoke ... from public` does NOT remove
-- them — they have to be revoked by role name. (crew-mode §2's note; it has bitten
-- this project more than once.) Each of these fails closed on auth.uid() anyway,
-- but nobody should have to re-derive that.
revoke execute on function public.crew_job_messages(uuid)        from public, anon;
revoke execute on function public.crew_post_message(uuid, text, text) from public, anon;
revoke execute on function public.crew_message_inbox()           from public, anon;
grant  execute on function public.crew_job_messages(uuid)        to authenticated;
grant  execute on function public.crew_post_message(uuid, text, text) to authenticated;
grant  execute on function public.crew_message_inbox()           to authenticated;

-- The identity trigger is called by the trigger machinery, never by a client.
revoke execute on function public.crew_message_identity() from public, anon, authenticated;

-- ── 6. System events — the ONE that earns its place ─────────────────────────
-- ⛔⛔ DO NOT DUMP EVERY MUTATION IN HERE. A conversation that narrates the
-- database is a conversation nobody reads, and the messages that matter drown.
--
-- ⭐ THE RULE THAT KEEPS IT HONEST: **a system event may only JOIN a conversation
-- that already exists — it may never START one.** If nobody has said anything
-- about this visit, moving it is already visible on the schedule and needs no
-- announcement. If a crew and an office ARE mid-conversation about it, "Tue Aug
-- 18 → Wed Aug 19" is the single most useful line that could appear next, and its
-- absence is what makes the thread lie.
--
-- That rule is also what stops this trigger costing anything: bulk reschedules,
-- season generation and the optimizer touch thousands of rows that have never
-- been talked about, and every one of them exits on the `exists` check.
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
    return new;                        -- no conversation to join
  end if;

  if new.scheduled_date is distinct from old.scheduled_date then
    v_body := 'Schedule changed — '
           || to_char(old.scheduled_date, 'Dy Mon FMDD')
           || ' → ' || to_char(new.scheduled_date, 'Dy Mon FMDD');
  else
    -- ⚠️ `to_char(time, text)` DOES NOT EXIST in PostgreSQL — there is no such
    -- overload, and the trigger would raise on every retimed visit. Adding the
    -- time to a date produces a timestamp, which to_char does accept.
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

-- ── 7. Telling the owner, without a second inbox ────────────────────────────
-- The owner already has ONE place that answers "what needs me" — the
-- notifications bell. A crew message rings it; an owner's own message does not,
-- and a system event does not.
--
-- ⭐ DEDUPED ON *UNREAD*, NOT FOR ALL TIME. /api/crew/complete dedupes per
-- (type, job) forever, which is right for "this visit failed to invoice" — it is
-- one fact. A conversation is not one fact: once the owner has read the bell,
-- the NEXT message from the field has to be able to ring it again, or the second
-- half of every exchange is silent. So a new bell is suppressed only while an
-- unread one for this visit is still sitting there.
--
-- ⛔ NO SMS, NO EMAIL. Those cost money, reach people off-shift, and route
-- through the consent + governor architecture that exists for CUSTOMER comms.
-- In-app only in V1.
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

-- ── 8. Media on a message — reusing Session 35, not rebuilding it ───────────
-- ⭐ ONE nullable column, and crew_media keeps every property it already had: the
-- PRIVATE bucket, the 50 MB ceiling and MIME allowlist enforced ON THE BUCKET,
-- the owner's RLS policy, and /api/crew/media as the only door that mints a
-- signed URL. A second bucket or a second table would have duplicated all four.
--
-- NULL = what it has always meant: reference material the OFFICE attached to the
-- visit ("this gate"), shown under the work instructions.
-- SET     = an attachment on one thing somebody said ("we're short — look").
-- Readers filter on it so the two never render as each other; the storage,
-- authorization and expiry story is identical for both.
alter table public.crew_media
  add column if not exists message_id uuid references public.crew_messages(id) on delete cascade;

create index if not exists crew_media_message_idx on public.crew_media (message_id)
  where message_id is not null;

comment on column public.crew_media.message_id is
  'NULL = office reference material for the visit (the original meaning). Set = an attachment on that crew_messages row. Deleting the message takes its attachments with it.';
