-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716054700
--   name    : portal_self_service_expansion
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- Portal self-service expansion: structured requests + two-way portal messages.
-- Mirror of supabase/RUN-2026-07-15-portal-self-service.sql (the repo record).

alter table public.service_requests
  add column if not exists kind text not null default 'service',
  add column if not exists preferred_date date,
  add column if not exists job_id uuid references public.jobs(id) on delete set null,
  add column if not exists recurrence_id uuid references public.job_recurrences(id) on delete set null,
  add column if not exists details jsonb;

alter table public.service_requests drop constraint if exists service_requests_kind_check;
alter table public.service_requests add constraint service_requests_kind_check
  check (kind in ('service','appointment','reschedule','plan_change'));

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
  if p_job_id is not null and not exists (
    select 1 from public.jobs where id = p_job_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  if p_recurrence_id is not null and not exists (
    select 1 from public.job_recurrences where id = p_recurrence_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  if (select count(*) from public.service_requests
       where customer_id = v_customer and created_at > now() - interval '1 hour') >= 20
  then return false; end if;
  insert into public.service_requests (user_id, customer_id, message, kind, preferred_date, job_id, recurrence_id, details)
    values (v_user, v_customer, left(trim(p_message), 2000), p_kind, p_preferred_date, p_job_id, p_recurrence_id, p_details);
  return true;
end; $$;
grant execute on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb) to anon, authenticated;

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