-- A website lead is threaded as an inbound portal message. Reusing an existing
-- customer's muted conversation previously suppressed the only owner bell for the
-- new request. Keep mute semantics for ordinary inbound messages, while treating a
-- structured service request as an operational alert that always reaches the bell.

create or replace function public.notify_inbound_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_muted boolean;
  v_portal_request boolean;
begin
  if new.direction <> 'inbound' then return new; end if;

  v_portal_request := new.channel = 'portal'
    and coalesce(new.meta ? 'service_request_id', false);

  select muted into v_muted
    from public.conversations
    where id = new.conversation_id;

  -- A mute still suppresses ordinary replies and unstructured portal messages.
  -- Structured requests (including website leads) remain visible operational work.
  if coalesce(v_muted, false) and not v_portal_request then return new; end if;

  select name into v_name from public.customers where id = new.customer_id;
  insert into public.notifications
    (user_id, type, title, body, customer_id, entity_type, entity_id, href)
  values (
    new.user_id,
    case when v_portal_request then 'portal_request' else 'new_message' end,
    coalesce(nullif(v_name, ''), 'A customer')
      || case when v_portal_request then ' sent a request from the portal'
              when new.channel = 'portal' then ' sent you a message from the portal'
              else ' replied by text' end,
    left(new.body, 140),
    new.customer_id, 'message', new.id, '/dashboard/messages?c=' || new.customer_id
  );
  return new;
end;
$$;

revoke all on function public.notify_inbound_message() from public, anon, authenticated, service_role;
grant execute on function public.notify_inbound_message() to service_role;
