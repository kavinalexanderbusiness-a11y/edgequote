-- ── Communications Center round 2: deep links + insights ─────────────────────
-- 1) Message notifications now carry ?c=<customer_id> so the bell / push tap
--    opens THE conversation, not the bare inbox (the inbox consumes the param).
--    Redefined FROM THE LIVE PROD FUNCTION (which is newer than schema.sql —
--    it distinguishes portal requests from portal messages); only href changes.
-- 2) comms_insights(p_days): one RPC for the Communications insights strip —
--    send/delivery/failure counts from notification_log (THE send ledger),
--    conversation + reply-latency stats from messages/conversations. SECURITY
--    INVOKER (RLS applies) + explicit auth.uid() scoping.

create or replace function public.notify_inbound_message()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    new.customer_id, 'message', new.id, '/dashboard/messages?c=' || new.customer_id
  );
  return new;
end; $function$;

-- The insights engine: everything the strip shows comes from THIS one function,
-- so any future surface (dashboard widget, weekly review) reuses it instead of
-- re-deriving the maths. median_reply_minutes pairs each inbound message with
-- the FIRST outbound after it (same customer); pairs answered >7d later count
-- as unanswered rather than dragging the median into nonsense.
create or replace function public.comms_insights(p_days int default 30)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sends', (select count(*) from public.notification_log
              where user_id = auth.uid() and created_at > now() - make_interval(days => p_days)
                and status in ('sent','delivered','opened','clicked')),
    'delivered', (select count(*) from public.notification_log
                  where user_id = auth.uid() and created_at > now() - make_interval(days => p_days)
                    and status in ('delivered','opened','clicked')),
    'failed', (select count(*) from public.notification_log
               where user_id = auth.uid() and created_at > now() - make_interval(days => p_days)
                 and status in ('error','failed','bounced','spam')),
    'skipped', (select count(*) from public.notification_log
                where user_id = auth.uid() and created_at > now() - make_interval(days => p_days)
                  and status in ('skipped','disabled')),
    'inbound', (select count(*) from public.messages
                where user_id = auth.uid() and direction = 'inbound'
                  and created_at > now() - make_interval(days => p_days)),
    'needs_reply', (select count(*) from public.conversations
                    where user_id = auth.uid() and archived_at is null and last_direction = 'inbound'),
    'scheduled_pending', (select count(*) from public.scheduled_messages
                          where user_id = auth.uid() and status = 'pending'),
    'median_reply_minutes', (
      with pairs as (
        select m.created_at as in_at,
               (select min(o.created_at) from public.messages o
                 where o.user_id = m.user_id and o.customer_id = m.customer_id
                   and o.direction = 'outbound' and o.created_at > m.created_at) as out_at
        from public.messages m
        where m.user_id = auth.uid() and m.direction = 'inbound'
          and m.created_at > now() - make_interval(days => p_days)
      )
      select round((percentile_cont(0.5) within group (order by extract(epoch from (out_at - in_at)) / 60))::numeric, 1)
      from pairs
      where out_at is not null and out_at - in_at < interval '7 days'
    )
  );
$$;

grant execute on function public.comms_insights(int) to authenticated;
