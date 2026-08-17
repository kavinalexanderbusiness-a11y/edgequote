-- ââ The portal proves BOTH the customer and the tenant âââââââââââââââââââââââ
--
-- Defence in depth behind the composite foreign key shipped in
-- 20260816020000. That constraint makes a token pairing one tenant's user_id
-- with another tenant's customer impossible to INSERT, which is what makes every
--  below tenant-correct today.
--
-- This closes the same hole a second time, at the read: every customer-keyed
-- lookup in the portal family now also constrains user_id, so a token row that
-- ever became inconsistent by some other route â a service_role write, a
-- restore, a future migration â still cannot read or move another tenant's data.
--
-- â ï¸ EVERY BODY BELOW WAS READ FROM PRODUCTION with pg_get_functiondef and
-- edited in place. It is NOT a repo copy. Replaying an older get_portal_data has
-- silently regressed this database twice (docs/MIGRATIONS.md); the only safe
-- source for a CREATE OR REPLACE here is the live definition.
--
-- The token lookup itself is deliberately untouched: it resolves BY TOKEN, which
-- is the credential being presented.


-- ââ get_portal_data â 11 customer-keyed projections âââââââââââââââââââââââââ
CREATE OR REPLACE FUNCTION public.get_portal_data(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    -- review_declined_at: the customer's own "No thanks", so it survives the session.
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in, reviewed_at, review_declined_at, autopay_enabled from public.customers where id = v_customer and user_id = v_user) c),
    -- service_seasons: buildServicePlans needs the owner's REAL season window.
    -- gst_number: CRA requires the supplier's registration number on a $30+ invoice
    -- for the customer to claim an ITC. Null when not registered; the PDFs print it
    -- only when gst_percent > 0 AND it is set.
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, email_secondary, website, logo_url, logo_scale, base_address, terms_text, review_url, coalesce(gst_percent,0) as gst_percent, gst_number, etransfer_email, service_seasons from public.business_settings where user_id = v_user) b),
    -- The owner's OWN catalogue â what this business actually sells. Drives the
    -- portal's "Request a service" tab, so it lists pool visits for a pool company
    -- and window cleaning for a window cleaner. Active only, in the owner's order.
    'services', coalesce((select json_agg(s order by s.sort_order, s.name) from (
      select name, category, default_rate, pricing_display_type, default_description, sort_order
      from public.service_templates
      where user_id = v_user and is_active
    ) s), '[]'::json),
    -- UNCHANGED â the primary property. Kept because Home/PropertyTab/PDF fallbacks
    -- read it today; 'properties' below is the addition, not a replacement.
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, notes from public.properties where customer_id = v_customer and user_id = v_user order by is_primary desc nulls last, created_at asc limit 1) p),
    -- NEW â EVERY property this customer owns. `id` is the join key the quotes and
    -- invoices projections below now carry; without it a card cannot name its own
    -- address or area, and 'property' above can only ever answer for the primary.
    -- Same ordering as the singular so properties[0] === property.
    'properties', coalesce((select json_agg(p order by p.is_primary desc nulls last, p.created_at asc) from (
      select id, address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, is_primary, created_at
      from public.properties where customer_id = v_customer and user_id = v_user
    ) p), '[]'::json),
    -- property_id (NEW): which property this quote is actually for. NULL on legacy
    -- rows (4 of 62 at time of writing) â the client falls back to qt.address text
    -- and suppresses any area claim rather than borrowing the primary's.
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (
      select qt.id, qt.quote_number, qt.service_type, qt.address, qt.property_id, qt.total, qt.initial_price, qt.subtotal,
             qt.weekly_price, qt.biweekly_price, qt.monthly_price, qt.notes, qt.status, qt.created_at,
             qt.issued_date, qt.crew_size, qt.hours, qt.travel_fee, qt.valid_until,
             qt.selected_option_id,
             -- accepted_price: what the customer CONSENTED to (selected option +
             -- travel, snapshotted at approval) â the scheduling deposit derives
             -- from this, never from a live total an edit could move.
             -- deposit_type/deposit_value: the scheduling-deposit rule.
             -- preferred_*: the customer's own scheduling REQUEST (a preference,
             -- never a booking) â shown back so a reload keeps what they told us.
             qt.accepted_price, qt.deposit_type, qt.deposit_value,
             qt.preferred_date, qt.preferred_date_2, qt.preferred_timing, qt.preferred_note,
             coalesce((select json_agg(o order by o.sort_order) from (
               select qo.id, qo.name, qo.description, qo.price, qo.sort_order, qo.is_recommended
               from public.quote_options qo where qo.quote_id = qt.id
             ) o), '[]'::json) as options,
             coalesce((select json_agg(a order by a.sort_order) from (
               select qa.id, qa.name, qa.description, qa.price, qa.sort_order, qa.is_selected
               from public.quote_addons qa where qa.quote_id = qt.id
             ) a), '[]'::json) as addons,
             coalesce((select json_agg(s order by s.sort_order) from (
               select qs.service_type, qs.quantity, qs.unit, qs.unit_price, qs.est_minutes,
                      qs.discount_type, qs.discount_value, qs.notes, qs.sort_order
               from public.quote_services qs where qs.quote_id = qt.id
             ) s), '[]'::json) as services
      from public.quotes qt where qt.customer_id = v_customer and qt.user_id = v_user and qt.status <> 'draft') q), '[]'::json),
    -- property_id (NEW): same reason. NULL is the honest answer for a combined
    -- invoice spanning properties â do not infer one.
    -- â `and status <> 'draft'` IS A PRIVACY PREDICATE, NOT A FILTER PREFERENCE.
    -- A draft is the owner's unfinished, unsent bill. Without this clause it was
    -- serialized into the customer's payload and read straight out of devtools â
    -- the portal only declined to RENDER it. Same predicate the quotes select
    -- above has always carried. Deleting it re-opens a confirmed data exposure.
    -- deposit_amount / deposit_requested_at: the deposit surface reads these.
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, amount_paid, status, issued_date, due_date, notes, address, property_id, line_items, job_id, created_at, discount_type, discount_value, deposit_amount, deposit_requested_at from public.invoices where customer_id = v_customer and user_id = v_user and status <> 'draft') i), '[]'::json),
    -- quote_id: which booking a pre-invoice deposit secures. The portal derives
    -- "deposit received" from these rows (signed cash sum), never from a flag.
    'payments', coalesce((select json_agg(pm order by pm.paid_at desc nulls last) from (select id, amount, status, paid_at, provider, kind, invoice_id, quote_id, created_at from public.payments where customer_id = v_customer and user_id = v_user and status = 'paid') pm), '[]'::json),
    -- property_id, quote_id, price, is_initial_visit: buildServicePlans groups by
    -- property and uses jobVisitValue to separate initial from recurring price.
    --
    -- ââ THE INTERNAL ACCESS NOTE IS NOT IN THIS PROJECTION, AND MUST NEVER BE
    -- PUT BACK. jobs.notes is written for whoever DOES the work â the job form
    -- calls it "notes for whoever does the work", crew_day ships it to the
    -- worker's phone as "the access note (gate code, where to park)". It was
    -- selected here and rendered verbatim in the customer's visit history: 49 of
    -- 78 completed production visits carried one, including "dog removal, keep
    -- gate closed". Removing it here kills the leak AT THE SOURCE â a portal
    -- component cannot render what was never serialized.
    -- â jobs.completion_issue is internal for the same reason and likewise absent.
    -- â­ jobs.completion_summary is the CUSTOMER-VISIBLE field, written for the
    -- person who paid: it replaces the access note as the words on a finished
    -- visit. `verify:completion` fails the build if either internal field
    -- reappears in this line.
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, property_id, quote_id, price, is_initial_visit, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, completion_summary from public.jobs where customer_id = v_customer and user_id = v_user and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    -- start_date, end_count: the series' own window and count limit.
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, start_date, end_date, end_count from public.job_recurrences where customer_id = v_customer and user_id = v_user) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer and user_id = v_user) p), '[]'::json),
    'change_orders', coalesce((select json_agg(co order by co.created_at desc) from (select id, co_number, job_id, quote_id, description, amount, status, decided_via, created_at, sent_at, approved_at, declined_at from public.change_orders where customer_id = v_customer and user_id = v_user and status <> 'draft') co), '[]'::json),
    'payment_method', (select to_json(pm) from (select brand, last4, exp_month, exp_year from public.payment_methods where customer_id = v_customer and user_id = v_user and is_default order by created_at desc limit 1) pm)
  ) into result;
  return result;
end; $function$;

-- ââ portal_accept_quote â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_accept_quote(p_token text, p_quote_id uuid, p_option_id uuid DEFAULT NULL::uuid, p_addon_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens
   where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  -- This door proves the quote is this token's customer's and still out for
  -- approval. Which OPTION and which EXTRAS belong to the quote is the core's
  -- question â a token proves WHICH CUSTOMER, never WHICH ROW.
  -- â 'sent' only: a draft is the owner's unfinished document and is never
  -- shown to a customer, so it can never be approved from here.
  if not exists (
    select 1 from public.quotes
     where id = p_quote_id and customer_id = v_customer and user_id = v_user and status = 'sent'
  ) then
    return false;
  end if;

  return public.quote_apply_choice(p_quote_id, p_option_id, p_addon_ids, 'portal');
end $function$;

-- ââ portal_add_contact â 3 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_add_contact(p_token text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    from public.customers where id = v_customer and user_id = v_user;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));

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
   where id = v_customer and user_id = v_user;

  if v_phone is not null then v_added := array_append(v_added, 'phone'); end if;
  if v_email is not null then v_added := array_append(v_added, 'email'); end if;

  select nullif(btrim(phone), '') is not null, nullif(btrim(email), '') is not null
    into v_has_phone, v_has_email
    from public.customers where id = v_customer and user_id = v_user;

  v_note := 'Customer added their own contact details from the portal â '
         || array_to_string(array_remove(array[
              case when v_phone is not null then 'Phone: ' || v_phone end,
              case when v_email is not null then 'Email: ' || v_email end
            ], null), ' Â· ');
  insert into public.service_requests (user_id, customer_id, message, status)
  values (v_user, v_customer, left(v_note, 1000), 'handled');

  return jsonb_build_object(
    'ok', true, 'reason', null,
    'added', to_jsonb(v_added),
    'skipped', to_jsonb(v_skipped),
    'has_phone', v_has_phone,
    'has_email', v_has_email);
end $function$;

-- ââ portal_begin_setup â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_begin_setup(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(c) into result from (
    select id, user_id, name, email, stripe_customer_id from public.customers where id = v_customer and user_id = v_user
  ) c;
  return result;
end; $function$;

-- ââ portal_decline_review â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_decline_review(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.customers
    set review_declined_at = coalesce(review_declined_at, now())
    where id = v_customer and user_id = v_user;
  return true;
end; $function$;

-- ââ portal_invoice_for_payment â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_invoice_for_payment(p_token text, p_invoice_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(i) into result from (
    select id, invoice_number, service_type, amount, amount_paid, status, customer_id, user_id
    from public.invoices where id = p_invoice_id and customer_id = v_customer and user_id = v_user and status in ('unpaid','sent','partial')
  ) i;
  return result;
end; $function$;

-- ââ portal_mark_reviewed â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_mark_reviewed(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.customers
    set reviewed_at   = coalesce(reviewed_at, now()),
        review_source = coalesce(review_source, 'Google')
    where id = v_customer and user_id = v_user;
  return true;
end; $function$;

-- ââ portal_remove_card â 3 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_remove_card(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_pms json;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select coalesce(json_agg(stripe_payment_method_id), '[]'::json) into v_pms
    from public.payment_methods where customer_id = v_customer and user_id = v_user;
  delete from public.payment_methods where customer_id = v_customer and user_id = v_user;
  update public.customers set autopay_enabled = false where id = v_customer and user_id = v_user;
  return v_pms;
end; $function$;

-- ââ portal_set_autopay â 2 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_set_autopay(p_token text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_has_card boolean;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  if p_enabled then
    select exists(select 1 from public.payment_methods where customer_id = v_customer and user_id = v_user) into v_has_card;
    if not v_has_card then return false; end if;   -- can't enable AutoPay with no card
  end if;
  update public.customers set autopay_enabled = p_enabled where id = v_customer and user_id = v_user;
  return true;
end; $function$;

-- ââ portal_set_consent â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_set_consent(p_token text, p_sms_opt_in boolean, p_email_opt_in boolean, p_prefs jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_old_sms boolean; v_old_email boolean;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  select sms_opt_in, email_opt_in into v_old_sms, v_old_email from public.customers where id = v_customer and user_id = v_user;
  update public.customers
     set sms_opt_in = p_sms_opt_in,
         email_opt_in = p_email_opt_in,
         message_prefs = coalesce(p_prefs, message_prefs)
   where id = v_customer and user_id = v_user;
  if v_old_sms is distinct from p_sms_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'sms', v_old_sms, p_sms_opt_in, 'portal', 'customer (portal)');
  end if;
  if v_old_email is distinct from p_email_opt_in then
    insert into public.consent_changes (user_id, customer_id, channel, old_value, new_value, source, changed_by)
    values (v_user, v_customer, 'email', v_old_email, p_email_opt_in, 'portal', 'customer (portal)');
  end if;
  return true;
end $function$;

-- ââ portal_set_scheduling_preference â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_set_scheduling_preference(p_token text, p_quote_id uuid, p_date date DEFAULT NULL::date, p_date_2 date DEFAULT NULL::date, p_timing text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid;
begin
  select customer_id, user_id into v_customer, v_user from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  if p_timing is not null and p_timing not in ('morning','afternoon') then return false; end if;
  if p_date_2 is not null and p_date is null then return false; end if;
  if p_date is not null and p_date < current_date - 1 then return false; end if;
  if p_date_2 is not null and p_date_2 < current_date - 1 then return false; end if;
  if p_note is not null and char_length(p_note) > 500 then return false; end if;

  update public.quotes
     set preferred_date   = p_date,
         preferred_date_2 = p_date_2,
         preferred_timing = p_timing,
         preferred_note   = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_quote_id
     and customer_id = v_customer and user_id = v_user
     and status = 'accepted';
  return found;
end $function$;

-- ââ portal_submit_request â 1 customer-keyed clause(s) scoped ââ
CREATE OR REPLACE FUNCTION public.portal_submit_request(p_token text, p_message text, p_kind text DEFAULT 'service'::text, p_preferred_date date DEFAULT NULL::date, p_job_id uuid DEFAULT NULL::uuid, p_recurrence_id uuid DEFAULT NULL::uuid, p_details jsonb DEFAULT NULL::jsonb, p_photos text[] DEFAULT NULL::text[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_msg text; v_photos text[]; v_key text;
begin
  -- The token proves WHICH CUSTOMER. Everything below is re-resolved against it.
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  v_msg := left(btrim(coalesce(p_message, '')), 2000);
  if v_msg = '' then return false; end if;
  if p_kind not in ('service','appointment','reschedule','plan_change','additional_work') then return false; end if;

  -- A caller-supplied id proves nothing on its own: a job or plan named here must
  -- belong to THIS token's customer AND this business, or the request is refused.
  if p_job_id is not null and not exists (
    select 1 from public.jobs where id = p_job_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  if p_recurrence_id is not null and not exists (
    select 1 from public.job_recurrences where id = p_recurrence_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;

  -- Media is REFUSED, never silently dropped. A legitimate client can only ever
  -- produce paths it just uploaded, so a malformed one means the call was
  -- tampered with â and quietly discarding a photo the customer attached would
  -- be the portal lying about what it sent.
  v_photos := coalesce(p_photos, '{}'::text[]);
  if not public.portal_request_photos_ok(v_photos) then return false; end if;

  if (select count(*) from public.service_requests
       where customer_id = v_customer and user_id = v_user and created_at > now() - interval '1 hour') >= 20
  then return false; end if;

  -- Same ask, same day preference, same visit â same key. Paired with the partial
  -- unique index, a resubmission while the first is still open is a no-op that
  -- still reports success: the request IS on file, which is what the customer
  -- asked to be true.
  v_key := md5(p_kind || '|' || lower(v_msg) || '|'
            || coalesce(p_preferred_date::text, '') || '|' || coalesce(p_job_id::text, ''));

  insert into public.service_requests
    (user_id, customer_id, message, kind, preferred_date, job_id, recurrence_id, details, photos, from_portal, dedup_key)
  values
    (v_user, v_customer, v_msg, p_kind, p_preferred_date, p_job_id, p_recurrence_id, p_details, v_photos, true, v_key)
  on conflict do nothing;

  return true;
end; $function$;
