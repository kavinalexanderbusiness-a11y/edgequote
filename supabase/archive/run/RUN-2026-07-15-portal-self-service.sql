-- ══════════════════════════════════════════════════════════════════════════════
-- Portal self-service expansion: two-way Messages + structured requests
-- (appointment, reschedule, plan change) on the EXISTING request pipeline.
--
-- APPLIED + VERIFIED IN PROD 2026-07-15 (functions executed against real tokens
-- inside a rolled-back transaction, not just inspected). This file is the repo's
-- record of what ran — there is no migration ledger in this project.
--
-- WHY: the portal could ask for a service in free text and nothing else. A
-- customer who wanted a visit on a specific day, a different date for an already
-- booked visit, or to pause/skip/cancel a recurring plan had to type it into the
-- generic ask box — and could never see the owner's replies at all. Every one of
-- those is a conversation the owner already runs through the ONE Messages hub, so
-- this expansion adds NO new pipeline:
--
--   • Structured requests reuse service_requests → sr_to_conversation (trigger)
--     → conversation + inbound 'portal' message + unread bump + owner
--     notification. New columns carry the structure; the trigger is untouched
--     because the portal composes a fully human-readable message body.
--   • The portal Messages tab reads/writes the SAME messages table the owner's
--     hub uses (outbound SMS are already recorded there), via two token-scoped
--     RPCs. lib/comms/* (frozen) is not involved — nothing here SENDS anything.
--
-- Customer actions are REQUESTS the owner confirms — nothing here mutates jobs
-- or job_recurrences. Scheduling stays owner-driven (and frozen at 1d4ef66).
--
-- SAFETY: additive only. New columns have defaults; new functions have NEW names
-- (portal_request_service keeps its exact 2-arg signature so PostgREST never
-- faces an ambiguous overload and old cached portal bundles keep working).
-- get_portal_data is NOT touched (see prod-schema-exceeds-main: seven files
-- replace it; only the newest may ever run). notify_inbound_message is replaced
-- from its LIVE body (fetched via pg_get_functiondef immediately before writing
-- this file) with one copy improvement for direct portal messages.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1) service_requests grows structure for the new request kinds ─────────────
-- kind: what the customer is asking for. 'service' (existing free-text/preset ask),
-- 'appointment' (visit on a preferred date), 'reschedule' (move an existing visit),
-- 'plan_change' (pause / skip next / cancel a recurring plan).
alter table public.service_requests
  add column if not exists kind text not null default 'service',
  add column if not exists preferred_date date,
  add column if not exists job_id uuid references public.jobs(id) on delete set null,
  add column if not exists recurrence_id uuid references public.job_recurrences(id) on delete set null,
  add column if not exists details jsonb;

alter table public.service_requests drop constraint if exists service_requests_kind_check;
alter table public.service_requests add constraint service_requests_kind_check
  check (kind in ('service','appointment','reschedule','plan_change'));

-- ── 2) Structured submit — ONE new function for all request kinds ─────────────
-- p_message is the human-readable composition the thread displays; the structured
-- columns exist so the owner's side can grow one-tap actions later without
-- parsing prose back apart.
create or replace function public.portal_submit_request(
  p_token text,
  p_message text,
  p_kind text default 'service',
  p_preferred_date date default null,
  p_job_id uuid default null,
  p_recurrence_id uuid default null,
  p_details jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  if coalesce(trim(p_message), '') = '' then return false; end if;
  if p_kind not in ('service','appointment','reschedule','plan_change') then return false; end if;
  -- A token must never attach a request to someone else's job or plan — the
  -- referenced row has to belong to THIS token's customer and business.
  if p_job_id is not null and not exists (
    select 1 from public.jobs where id = p_job_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  if p_recurrence_id is not null and not exists (
    select 1 from public.job_recurrences where id = p_recurrence_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  -- Anti-flood: this is an anonymous, token-keyed endpoint with buttons that
  -- compose messages — cap it well above any honest use.
  if (select count(*) from public.service_requests
       where customer_id = v_customer and created_at > now() - interval '1 hour') >= 20
  then return false; end if;
  insert into public.service_requests (user_id, customer_id, message, kind, preferred_date, job_id, recurrence_id, details)
    values (v_user, v_customer, left(trim(p_message), 2000), p_kind, p_preferred_date, p_job_id, p_recurrence_id, p_details);
  return true;
end; $$;
grant execute on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb) to anon, authenticated;

-- ── 3) Two-way messages: read the thread ───────────────────────────────────────
-- Returns the last 200 messages of the customer's ONE conversation, oldest first.
-- Only body/direction/channel/created_at — never meta (internal ids) or provider
-- fields. Everything outbound here was already sent TO this customer by SMS/email,
-- so showing it is showing them their own inbox.
create or replace function public.portal_get_messages(p_token text)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'id', m.id, 'direction', m.direction, 'channel', m.channel,
           'body', m.body, 'created_at', m.created_at) order by m.created_at), '[]'::json)
    from (
      select msg.id, msg.direction, msg.channel, msg.body, msg.created_at
        from public.messages msg
        join public.conversations c on c.id = msg.conversation_id
        join public.customer_portal_tokens t
          on t.customer_id = c.customer_id and t.user_id = c.user_id
       where t.token = p_token and not t.revoked
       order by msg.created_at desc
       limit 200
    ) m;
$$;
grant execute on function public.portal_get_messages(text) to anon, authenticated;

-- ── 4) Two-way messages: send ──────────────────────────────────────────────────
-- Mirrors sr_to_conversation's find-or-create + insert exactly, minus the
-- service_requests row (a chat message is not a request). bump_conversation and
-- notify_inbound_message fire off the insert as they do for every other message.
create or replace function public.portal_send_message(p_token text, p_body text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; v_convo uuid;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  if coalesce(trim(p_body), '') = '' then return false; end if;
  select id into v_convo from public.conversations
    where user_id = v_user and customer_id = v_customer;
  if v_convo is null then
    insert into public.conversations (user_id, customer_id, last_message_at)
      values (v_user, v_customer, now()) returning id into v_convo;
  end if;
  -- Anti-flood, same rationale as portal_submit_request.
  if (select count(*) from public.messages
       where conversation_id = v_convo and direction = 'inbound' and channel = 'portal'
         and created_at > now() - interval '1 hour') >= 30
  then return false; end if;
  insert into public.messages (user_id, conversation_id, customer_id, direction, channel, body, status, meta)
    values (v_user, v_convo, v_customer, 'inbound', 'portal', left(trim(p_body), 2000), 'received',
            jsonb_build_object('portal_message', true));
  return true;
end; $$;
grant execute on function public.portal_send_message(text, text) to anon, authenticated;

-- ── 5) notify_inbound_message: say what actually happened ─────────────────────
-- Base body = the LIVE function. One change: a direct portal message (no
-- service_request_id in meta) is "sent you a message", typed 'new_message' like
-- an SMS reply — 'portal_request' stays reserved for actual requests.
CREATE OR REPLACE FUNCTION public.notify_inbound_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_muted boolean;
begin
  if new.direction <> 'inbound' then return new; end if;
  select muted into v_muted from public.conversations where id = new.conversation_id;
  if coalesce(v_muted, false) then return new; end if;
  select name into v_name from public.customers where id = new.customer_id;
  insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, href)
  values (
    new.user_id,
    case when new.channel = 'portal' and (new.meta ? 'service_request_id') then 'portal_request'
         else 'new_message' end,
    coalesce(nullif(v_name, ''), 'A customer')
      || case when new.channel = 'portal' and (new.meta ? 'service_request_id') then ' sent a request from the portal'
              when new.channel = 'portal' then ' sent you a message from the portal'
              else ' replied by text' end,
    left(new.body, 140),
    new.customer_id, 'message', new.id, '/dashboard/messages'
  );
  return new;
end; $function$;
