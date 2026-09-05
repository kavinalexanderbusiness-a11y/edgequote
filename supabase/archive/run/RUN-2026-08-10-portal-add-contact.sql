-- ── portal_add_contact — the customer fills in a contact detail they're missing ──
--
-- WHY THIS EXISTS
-- 84 of 103 active customers have no email and 39 have no phone. The owner cannot
-- send an invoice, confirm a visit, or have the customer recover their own portal
-- link without one — and chasing that by hand is the work this replaces. The
-- portal already knows exactly who the customer is (they are holding a valid
-- token), so it can ask them, and the answer can go straight onto the file.
--
-- THE AUTHORITY MODEL — the same one portal_set_consent uses, and for the same
-- reason. The token is resolved server-side to (customer_id, user_id) and that
-- resolved id is the ONLY row this function will ever touch. There is deliberately
-- no p_customer_id parameter: a caller cannot name a row, so it cannot name
-- someone else's. Tenant scoping is inherited from the same lookup — the
-- duplicate checks below are filtered on the token's own user_id, so this
-- function cannot read across a tenant boundary either.
--
-- FOUR RULES IT ENFORCES, each of which is a bug if it stops being true:
--
--  1. FILL ONLY, NEVER OVERWRITE. A populated field is left exactly as it is.
--     Changing an email is an identity change — /portal-access recovery mails the
--     portal link to whatever address is on the customer record, so being able to
--     REPLACE one from inside the portal would let a leaked link rewrite where
--     future links are sent. Filling a blank one carries no such power (there was
--     no address to take over), which is why that half is safe and this half is
--     refused. The UI only ever asks for what's missing, so a populated field
--     arriving here is a race — reported, not applied.
--
--  2. CONSENT IS NOT TOUCHED. sms_opt_in, email_opt_in and message_prefs are not
--     in the UPDATE at all. HAVING a phone number is not agreeing to be texted:
--     lib/comms/reach.ts gates SMS on sms_opt_in with no transactional exemption,
--     and portal_set_consent (which writes consent_changes) remains the one door
--     that changes it. A customer who adds a number here is exactly as opted-in
--     the moment after as the moment before.
--
--  3. IT WILL NOT CREATE A DUPLICATE. customers.phone_digits is a STORED GENERATED
--     column and, with email, is what findCustomerMatch and resolve_intake_customer
--     key on to decide "same person". Nothing in the schema enforces uniqueness, so
--     writing a value another customer of this owner already holds would not fail —
--     it would quietly make the NEXT intake ambiguous, which is the exact failure
--     deduplication exists to prevent. The phone test uses right(digits, 10), the
--     same national-number rule both matchers use, so it cannot be evaded by
--     adding a country code.
--
--  4. IT REPORTS WHAT THE ROW HOLDS, NOT WHAT IT ATTEMPTED. The return value is
--     read back out of the customer row AFTER the update, so the portal can only
--     tell the customer "saved" because the row says so.
--
-- Validation is ALL-OR-NOTHING: both values are checked before either is written,
-- so the customer never has to reason about a half-applied save.
--
-- Safe to re-run.

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
  -- These two are appended with array_append, never with the || operator. Given an
  -- untyped literal, Postgres resolves || to array || array and parses 'phone' as
  -- an ARRAY LITERAL: "malformed array literal" (22P02) at runtime, on the success
  -- path only. No source scan or type-check can see it — the first live call did.
  v_added text[] := '{}'::text[];
  v_skipped text[] := '{}'::text[];
  v_has_phone boolean; v_has_email boolean;
  v_note text;
begin
  -- The token is the whole authority. Revoked tokens resolve to nothing, exactly
  -- as they do in get_portal_data and every other portal_* function.
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
  -- Lower-cased on the way in so the stored value matches what normalizeEmail
  -- (lib/customers) and find_portal_access_customers compare against.
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));

  -- Rule 1 — fill only.
  if v_phone is not null and v_cur_phone is not null then
    v_skipped := array_append(v_skipped, 'phone'); v_phone := null;
  end if;
  if v_email is not null and v_cur_email is not null then
    v_skipped := array_append(v_skipped, 'email'); v_email := null;
  end if;

  if v_phone is null and v_email is null then
    return jsonb_build_object(
      'ok', false,
      'reason', case when array_length(v_skipped, 1) > 0 then 'already_on_file' else 'nothing_to_add' end,
      'skipped', to_jsonb(v_skipped),
      'has_phone', v_cur_phone is not null,
      'has_email', v_cur_email is not null);
  end if;

  -- Validate BOTH before writing EITHER.
  -- Ten digits is the floor because that is a number the business can actually
  -- dial: phoneMatches() will link on seven, but seven is a local number missing
  -- its area code, and storing one produces a contact that fails at the moment it
  -- is needed. The client mirrors this threshold for instant feedback; THIS is the
  -- authority.
  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if length(v_digits) < 10 or length(v_digits) > 15 then
      return jsonb_build_object('ok', false, 'reason', 'bad_phone');
    end if;
  end if;
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]{2,}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;

  -- Rule 3 — never create a duplicate identity within this owner's book.
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

  -- Rule 2 — two columns, and only these two. coalesce keeps the untouched field
  -- byte-identical rather than re-writing it with its own value.
  update public.customers
     set phone = coalesce(v_phone, phone),
         email = coalesce(v_email, email),
         updated_at = now()
   where id = v_customer;

  if v_phone is not null then v_added := array_append(v_added, 'phone'); end if;
  if v_email is not null then v_added := array_append(v_added, 'email'); end if;

  -- Rule 4 — read the row back. "It saved" is a claim about state, not about a
  -- statement having run.
  select nullif(btrim(phone), '') is not null, nullif(btrim(email), '') is not null
    into v_has_phone, v_has_email
    from public.customers where id = v_customer;

  -- The owner finds out. loadCustomerTimelineSources reads service_requests
  -- (message, created_at) onto the customer timeline, so this is where "the phone
  -- number came from the customer on Aug 10" is recorded — an identity write with
  -- no trace is the thing worth avoiding here.
  -- status 'handled', NOT the 'new' default: nothing is being asked of the owner,
  -- the file is already updated, and a row in their open-requests queue would be a
  -- to-do that has no task behind it. kind stays 'service' — the CHECK constraint
  -- allows four values and inventing a fifth would mean auditing every reader.
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
  'Portal self-service: fill a MISSING customer phone/email from a valid portal token. '
  'Fills only — never overwrites a populated field (an email change is an identity change). '
  'Never touches sms_opt_in/email_opt_in/message_prefs. Refuses a value another customer '
  'of the same owner already holds. Returns the row state read back after the write.';

-- Same grants the sibling portal_* functions carry: the portal calls this as the
-- anonymous role. PUBLIC is revoked explicitly rather than left at the CREATE
-- default, so the grant list states exactly who may call it.
revoke all on function public.portal_add_contact(text, text, text) from public;
grant execute on function public.portal_add_contact(text, text, text) to anon, authenticated, service_role;
