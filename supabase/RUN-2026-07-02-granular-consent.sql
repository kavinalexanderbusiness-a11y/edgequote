-- ════════════════════════════════════════════════════════════
-- Granular messaging consent — CORRECTED against the LIVE production schema
-- (introspected 2026-07-13: portal tokens live in customer_portal_tokens,
--  consent_changes audits via old_value/new_value). Idempotent, safe to re-run.
-- ════════════════════════════════════════════════════════════

-- ── PART 1 — REQUIRED NOW ─────────────────────────────────────────────────────
-- The deployed code selects customers.message_prefs; without this column every
-- manual send 404s. This one line restores production messaging.
alter table public.customers add column if not exists message_prefs jsonb;

-- ── PART 2 — required before deploying the consent UI (portal categories +
-- website funnel consent). Written against the REAL schema. The 4-arg
-- portal_set_consent replaces the 3-arg one; existing named-arg callers still
-- resolve (p_prefs defaults to null).
drop function if exists public.portal_set_consent(text, boolean, boolean);
create or replace function public.portal_set_consent(
  p_token text, p_sms_opt_in boolean, p_email_opt_in boolean, p_prefs jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; v_old_sms boolean; v_old_email boolean;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  select sms_opt_in, email_opt_in into v_old_sms, v_old_email from public.customers where id = v_customer;
  update public.customers
     set sms_opt_in = p_sms_opt_in,
         email_opt_in = p_email_opt_in,
         message_prefs = coalesce(p_prefs, message_prefs)
   where id = v_customer;
  if v_old_sms is distinct from p_sms_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'sms', v_old_sms, p_sms_opt_in, 'portal', 'customer (portal)');
  end if;
  if v_old_email is distinct from p_email_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'email', v_old_email, p_email_opt_in, 'portal', 'customer (portal)');
  end if;
  return true;
end $$;
grant execute on function public.portal_set_consent(text, boolean, boolean, jsonb) to anon, authenticated;

create or replace function public.booking_set_consent(
  p_token text, p_quote_id uuid, p_sms_opt_in boolean, p_email_opt_in boolean, p_prefs jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_customer uuid; v_old_sms boolean; v_old_email boolean;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;
  select customer_id into v_customer from public.quotes where id = p_quote_id and user_id = v_user;
  if v_customer is null then return false; end if;
  select sms_opt_in, email_opt_in into v_old_sms, v_old_email from public.customers where id = v_customer;
  update public.customers
     set sms_opt_in = p_sms_opt_in, email_opt_in = p_email_opt_in,
         message_prefs = coalesce(p_prefs, message_prefs)
   where id = v_customer and user_id = v_user;
  if v_old_sms is distinct from p_sms_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'sms', v_old_sms, p_sms_opt_in, 'portal', 'customer (website booking)');
  end if;
  if v_old_email is distinct from p_email_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'email', v_old_email, p_email_opt_in, 'portal', 'customer (website booking)');
  end if;
  return true;
end $$;
grant execute on function public.booking_set_consent(text, uuid, boolean, boolean, jsonb) to anon, authenticated;

create or replace function public.portal_get_prefs(p_token text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(c.message_prefs, '{}'::jsonb)
    from public.customer_portal_tokens t
    join public.customers c on c.id = t.customer_id
   where t.token = p_token and not t.revoked
$$;
grant execute on function public.portal_get_prefs(text) to anon, authenticated;
