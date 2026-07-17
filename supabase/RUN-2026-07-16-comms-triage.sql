-- ── Communications round 3: triage primitives + one-query inbox counts ────────
-- Labels, snooze, and assignment live ON conversations (the one conversation
-- system) — no side tables, no parallel state. inbox_counts() replaces the six
-- per-filter COUNT round-trips the inbox fired on every realtime event.

alter table public.conversations add column if not exists labels text[] not null default '{}';
alter table public.conversations add column if not exists snoozed_until timestamptz;
-- Assignment references THE crew system (dispatch module's technicians).
alter table public.conversations add column if not exists assigned_to uuid references public.technicians(id) on delete set null;

create index if not exists conversations_labels_idx  on public.conversations using gin (labels);
create index if not exists conversations_snoozed_idx on public.conversations (user_id, snoozed_until) where snoozed_until is not null;

-- Snooze = "hide until"; display-time only, no cron. A NEW INBOUND message wakes
-- the conversation immediately (snoozed_until cleared here in the bump trigger) —
-- snoozing must never eat a customer's reply. Redefined FROM THE LIVE PROD
-- FUNCTION; the only change is the snoozed_until line.
create or replace function public.bump_conversation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.conversations set
    last_message_at = new.created_at,
    last_preview    = left(new.body, 140),
    last_direction  = new.direction,
    last_channel    = new.channel,
    unread          = case when new.direction = 'inbound' then unread + 1 else unread end,
    archived_at     = case when new.direction in ('inbound','outbound') then null else archived_at end,
    snoozed_until   = case when new.direction = 'inbound' then null else snoozed_until end
  where id = new.conversation_id;
  return new;
end; $function$;

-- ONE round trip for every inbox pill + the unread badge sum. Snoozed rows leave
-- the active filters and live under their own count; muted rows stay in the list
-- counts but never in unread_sum (mute means "stop counting this at me").
create or replace function public.inbox_counts()
returns jsonb
language sql
stable
as $$
  with c as (select archived_at, snoozed_until, lead_status, last_channel, last_direction, unread, muted
             from public.conversations where user_id = auth.uid()),
       awake as (select * from c where archived_at is null and (snoozed_until is null or snoozed_until <= now()))
  select jsonb_build_object(
    'all',          (select count(*) from awake),
    'needs_reply',  (select count(*) from awake where last_direction = 'inbound'),
    'sms',          (select count(*) from awake where lead_status is null and (last_channel = 'sms' or last_channel is null)),
    'portal',       (select count(*) from awake where lead_status is null and last_channel = 'portal'),
    'website_lead', (select count(*) from awake where lead_status = 'new'),
    'snoozed',      (select count(*) from c where archived_at is null and snoozed_until > now()),
    'archived',     (select count(*) from c where archived_at is not null),
    'unread_sum',   (select coalesce(sum(unread), 0) from c where archived_at is null and muted = false)
  );
$$;

grant execute on function public.inbox_counts() to authenticated;
