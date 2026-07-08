-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Granular messaging consent (reminders / invoices / estimates /
-- marketing / seasonal) — synced from the website funnel + portal.
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- Extends the EXISTING consent model (customers.sms_opt_in/email_opt_in +
-- consent_changes audit) with per-CATEGORY preferences — one jsonb column, so a
-- customer can take invoice texts but decline marketing. null / missing key =
-- inherit today's channel booleans (zero backfill, fully backward compatible).
-- Enforcement lives in the ONE dispatch engine (lib/comms/dispatch.ts).

-- (1) The preferences: { "reminders"|"invoices"|"estimates"|"marketing"|"seasonal": boolean }
alter table public.customers add column if not exists message_prefs jsonb;

-- (2) portal_set_consent gains the prefs param. The 3-arg version is DROPPED
-- (not overloaded) so named-arg RPC calls can never be ambiguous.
drop function if exists public.portal_set_consent(text, boolean, boolean);
create or replace function public.portal_set_consent(
  p_token text, p_sms_opt_in boolean, p_email_opt_in boolean, p_prefs jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_user uuid; v_old_sms boolean; v_old_email boolean;
begin
  select c.id, c.user_id, c.sms_opt_in, c.email_opt_in into v_cust, v_user, v_old_sms, v_old_email
    from public.customers c where c.portal_token = p_token;
  if v_cust is null then return false; end if;
  update public.customers
     set sms_opt_in = p_sms_opt_in,
         email_opt_in = p_email_opt_in,
         message_prefs = coalesce(p_prefs, message_prefs)
   where id = v_cust;
  if v_old_sms is distinct from p_sms_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, opted_in, source, changed_by)
    values (v_user, v_cust, 'sms', p_sms_opt_in, 'portal', 'customer (portal)');
  end if;
  if v_old_email is distinct from p_email_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, opted_in, source, changed_by)
    values (v_user, v_cust, 'email', p_email_opt_in, 'portal', 'customer (portal)');
  end if;
  if p_prefs is not null then
    insert into public.consent_changes (user_id, customer_id, channel, opted_in, source, changed_by)
    values (v_user, v_cust, 'prefs:' || (
      select coalesce(string_agg(k || '=' || (p_prefs->>k), ','), '') from jsonb_object_keys(p_prefs) k
    ), true, 'portal', 'customer (portal)');
  end if;
  return true;
end $$;
grant execute on function public.portal_set_consent(text, boolean, boolean, jsonb) to anon, authenticated;

-- (3) booking_set_consent — the website funnel's consent write, called right
-- after submit_booking (same best-effort pattern as record_booking_measurement).
-- Token-scoped to the business; applies to the just-created quote's customer.
create or replace function public.booking_set_consent(
  p_token text, p_quote_id uuid, p_sms_opt_in boolean, p_email_opt_in boolean, p_prefs jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_cust uuid;
begin
  select user_id into v_user from public.business_settings
   where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;
  select customer_id into v_cust from public.quotes where id = p_quote_id and user_id = v_user;
  if v_cust is null then return false; end if;
  update public.customers
     set sms_opt_in = p_sms_opt_in, email_opt_in = p_email_opt_in,
         message_prefs = coalesce(p_prefs, message_prefs)
   where id = v_cust and user_id = v_user;
  insert into public.consent_changes (user_id, customer_id, channel, opted_in, source, changed_by)
  values (v_user, v_cust, 'sms', p_sms_opt_in, 'portal', 'customer (website booking)'),
         (v_user, v_cust, 'email', p_email_opt_in, 'portal', 'customer (website booking)');
  return true;
end $$;
grant execute on function public.booking_set_consent(text, uuid, boolean, boolean, jsonb) to anon, authenticated;

-- (4) portal_get_prefs — tiny token-scoped read so the portal's preference card
-- shows the STORED categories (get_portal_data stays untouched).
create or replace function public.portal_get_prefs(p_token text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(c.message_prefs, '{}'::jsonb)
    from public.customers c where c.portal_token = p_token
$$;
grant execute on function public.portal_get_prefs(text) to anon, authenticated;
