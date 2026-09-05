-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053317
--   name    : change_orders_v1_state_machine
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.change_order_assign_number()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_next int;
begin
  if new.co_number is not null and btrim(new.co_number) <> '' then return new; end if;
  select coalesce(max((regexp_replace(co_number, '\D', '', 'g'))::int), 0) + 1
    into v_next
    from public.change_orders
   where user_id = new.user_id and co_number ~ '\d';
  new.co_number := 'CO-' || lpad(v_next::text, 4, '0');
  return new;
end $function$;

drop trigger if exists trg_change_order_assign_number on public.change_orders;
create trigger trg_change_order_assign_number
  before insert on public.change_orders
  for each row execute function public.change_order_assign_number();

create or replace function public.change_order_guard_transition()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.job_id is distinct from old.job_id
     or new.user_id is distinct from old.user_id
     or new.customer_id is distinct from old.customer_id then
    raise exception 'a change order cannot be moved to another job, customer or business'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'   and new.status in ('pending', 'cancelled'))
      or (old.status = 'pending' and new.status in ('approved', 'declined', 'cancelled'))
    ) then
      raise exception 'a % change order cannot become %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'pending'   then new.sent_at      := coalesce(old.sent_at, now()); end if;
    if new.status = 'approved'  then new.approved_at  := now(); end if;
    if new.status = 'declined'  then new.declined_at  := now(); end if;
    if new.status = 'cancelled' then new.cancelled_at := now(); end if;
  end if;

  if old.status <> 'draft'
     and (new.amount is distinct from old.amount or new.description is distinct from old.description) then
    raise exception 'the scope and price of a change order are fixed once it is sent for approval'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end $function$;

drop trigger if exists trg_change_order_guard_transition on public.change_orders;
create trigger trg_change_order_guard_transition
  before update on public.change_orders
  for each row execute function public.change_order_guard_transition();

create or replace function public.change_order_apply_approval()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    insert into public.job_line_items
      (user_id, job_id, description, amount, service_key, service_category, recurring, change_order_id)
    values
      (new.user_id, new.job_id, new.description, new.amount,
       coalesce(new.service_key, 'change_order'), new.service_category, false, new.id)
    on conflict (change_order_id) where change_order_id is not null do nothing;
  end if;
  return null;
end $function$;

drop trigger if exists trg_change_order_apply_approval on public.change_orders;
create trigger trg_change_order_apply_approval
  after update on public.change_orders
  for each row execute function public.change_order_apply_approval();

create or replace function public.notify_change_order_decision()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_name text;
begin
  if new.status not in ('approved', 'declined') or old.status is not distinct from new.status then
    return null;
  end if;
  if new.decided_via is distinct from 'portal' then return null; end if;
  select name into v_name from public.customers where id = new.customer_id;
  insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, amount, href)
  values (
    new.user_id,
    case when new.status = 'approved' then 'change_order_approved' else 'change_order_declined' end,
    coalesce(nullif(v_name, ''), 'A customer') ||
      case when new.status = 'approved' then ' approved a change' else ' declined a change' end,
    new.co_number || ' - $' || trim(to_char(new.amount, 'FM999990D00')) || ' - ' || left(new.description, 80),
    new.customer_id, 'job', new.job_id, new.amount, '/dashboard/schedule?focus=' || new.job_id
  );
  return null;
end $function$;

drop trigger if exists trg_notify_change_order_decision on public.change_orders;
create trigger trg_notify_change_order_decision
  after update on public.change_orders
  for each row execute function public.notify_change_order_decision();

revoke all on function public.change_order_assign_number() from public, anon, authenticated, service_role;
revoke all on function public.change_order_guard_transition() from public, anon, authenticated, service_role;
revoke all on function public.change_order_apply_approval() from public, anon, authenticated, service_role;
revoke all on function public.notify_change_order_decision() from public, anon, authenticated, service_role;