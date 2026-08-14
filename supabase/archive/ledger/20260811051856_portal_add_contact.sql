-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811051856
--   name    : portal_add_contact
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

create or replace function public.portal_add_contact(
  p_token text,
  p_phone text default null,
  p_email text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_customer uuid; v_user uuid;
  v_cur_phone text; v_cur_email text;
  v_phone text; v_email text; v_digits text;
  v_added text[] := '{}'::text[];
  v_skipped text[] := '{}'::text[];
  v_has_phone boolean; v_has_email boolean;
  v_note text;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens
   where token = p_token and not revoked;
  if v_customer is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token');
  end if;

  select nullif(btrim(phone), ''), nullif(btrim(email), '')
    into v_cur_phone, v_cur_email
    from public.customers where id = v_customer;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));

  if v_phone is not null and v_cur_phone is not null then
    v_skipped := v_skipped || 'phone'; v_phone := null;
  end if;
  if v_email is not null and v_cur_email is not null then
    v_skipped := v_skipped || 'email'; v_email := null;
  end if;

  if v_phone is null and v_email is null then
    return jsonb_build_object(
      'ok', false,
      'reason', case when array_length(v_skipped, 1) > 0 then 'already_on_file' else 'nothing_to_add' end,
      'skipped', to_jsonb(v_skipped),
      'has_phone', v_cur_phone is not null,
      'has_email', v_cur_email is not null);
  end if;

  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if length(v_digits) < 10 or length(v_digits) > 15 then
      return jsonb_build_object('ok', false, 'reason', 'bad_phone');
    end if;
  end if;
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]{2,}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;

  if v_phone is not null and exists (
    select 1 from public.customers
     where user_id = v_user and id <> v_customer and archived_at is null
       and length(phone_digits) >= 10
       and right(phone_digits, 10) = right(v_digits, 10)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'phone_taken');
  end if;
  if v_email is not null and exists (
    select 1 from public.customers
     where user_id = v_user and id <> v_customer and archived_at is null
       and lower(btrim(email)) = v_email
  ) then
    return jsonb_build_object('ok', false, 'reason', 'email_taken');
  end if;

  update public.customers
     set phone = coalesce(v_phone, phone),
         email = coalesce(v_email, email),
         updated_at = now()
   where id = v_customer;

  if v_phone is not null then v_added := v_added || 'phone'; end if;
  if v_email is not null then v_added := v_added || 'email'; end if;

  select nullif(btrim(phone), '') is not null, nullif(btrim(email), '') is not null
    into v_has_phone, v_has_email
    from public.customers where id = v_customer;

  v_note := 'Customer added their own contact details from the portal — '
         || array_to_string(array_remove(array[
              case when v_phone is not null then 'Phone: ' || v_phone end,
              case when v_email is not null then 'Email: ' || v_email end
            ], null), ' · ');
  insert into public.service_requests (user_id, customer_id, message, status)
  values (v_user, v_customer, left(v_note, 1000), 'handled');

  return jsonb_build_object(
    'ok', true, 'reason', null,
    'added', to_jsonb(v_added),
    'skipped', to_jsonb(v_skipped),
    'has_phone', v_has_phone,
    'has_email', v_has_email);
end $$;

comment on function public.portal_add_contact(text, text, text) is
  'Portal self-service: fill a MISSING customer phone/email from a valid portal token. Fills only - never overwrites a populated field (an email change is an identity change). Never touches sms_opt_in/email_opt_in/message_prefs. Refuses a value another customer of the same owner already holds. Returns the row state read back after the write.';

revoke all on function public.portal_add_contact(text, text, text) from public;
grant execute on function public.portal_add_contact(text, text, text) to anon, authenticated, service_role;