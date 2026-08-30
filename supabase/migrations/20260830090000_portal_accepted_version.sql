-- ── Session 112 · accepted-document-truth: the portal learns what was ACCEPTED ──
--
-- WHY A SCHEMA CHANGE (measured, not assumed): get_portal_data's quote
-- projection carried ZERO acceptance-ledger data — no snapshot, no
-- needs_reapproval, no accepted_at. The portal therefore rendered every quote,
-- accepted ones included, from the LIVE mutable row: customer accepts Version A,
-- owner revises, the customer's own screen and PDF silently become Version B.
-- The customer-facing half of the fix cannot exist without the payload carrying
-- the ledger's answer, so this evolves the ONE portal RPC (the standing rule:
-- one door, never a second) in place.
--
-- WHAT CHANGES: each quote row gains an `acceptance` object (nullable) read
-- from the LATEST quote_acceptances row: accepted_at · kind · accepted_amount ·
-- selected_option_id · document (the immutable snapshot) · terms_acknowledged ·
-- terms_text (the EXACT text agreed) · needs_reapproval (derived by fingerprint
-- at read time — the same expression quote_acceptance_state() uses; never
-- stored). Actor internals are not projected.
--
-- SAME SIGNATURE, plain CREATE OR REPLACE — no overload is created (the S121
-- lesson applies to NEW parameters; this adds none). Everything else in the
-- function body is byte-identical to the baseline's current definition.

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
    -- The owner's OWN catalogue — what this business actually sells. Drives the
    -- portal's "Request a service" tab, so it lists pool visits for a pool company
    -- and window cleaning for a window cleaner. Active only, in the owner's order.
    'services', coalesce((select json_agg(s order by s.sort_order, s.name) from (
      select name, category, default_rate, pricing_display_type, default_description, sort_order
      from public.service_templates
      where user_id = v_user and is_active
    ) s), '[]'::json),
    -- UNCHANGED — the primary property. Kept because Home/PropertyTab/PDF fallbacks
    -- read it today; 'properties' below is the addition, not a replacement.
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, notes from public.properties where customer_id = v_customer and user_id = v_user order by is_primary desc nulls last, created_at asc limit 1) p),
    -- NEW — EVERY property this customer owns. `id` is the join key the quotes and
    -- invoices projections below now carry; without it a card cannot name its own
    -- address or area, and 'property' above can only ever answer for the primary.
    -- Same ordering as the singular so properties[0] === property.
    'properties', coalesce((select json_agg(p order by p.is_primary desc nulls last, p.created_at asc) from (
      select id, address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, is_primary, created_at
      from public.properties where customer_id = v_customer and user_id = v_user
    ) p), '[]'::json),
    -- property_id (NEW): which property this quote is actually for. NULL on legacy
    -- rows (4 of 62 at time of writing) — the client falls back to qt.address text
    -- and suppresses any area claim rather than borrowing the primary's.
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (
      select qt.id, qt.quote_number, qt.service_type, qt.address, qt.property_id, qt.total, qt.initial_price, qt.subtotal,
             qt.weekly_price, qt.biweekly_price, qt.monthly_price, qt.notes, qt.status, qt.created_at,
             qt.issued_date, qt.crew_size, qt.hours, qt.travel_fee, qt.valid_until,
             qt.selected_option_id,
             -- accepted_price: what the customer CONSENTED to (selected option +
             -- travel, snapshotted at approval) — the scheduling deposit derives
             -- from this, never from a live total an edit could move.
             -- deposit_type/deposit_value: the scheduling-deposit rule.
             -- preferred_*: the customer's own scheduling REQUEST (a preference,
             -- never a booking) — shown back so a reload keeps what they told us.
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
             ) s), '[]'::json) as services,
             -- ── The accepted version (Session 112 · accepted-document-truth) ─────
             -- The LATEST acceptance-ledger row for this quote, so the portal can
             -- render what was ACCEPTED as a document distinct from the live row an
             -- owner may since have edited. needs_reapproval is DERIVED from the
             -- material fingerprint at read time — the same single expression
             -- quote_acceptance_state() uses — never a stored flag. Actor internals
             -- (actor_id, on-behalf notes, source) are deliberately NOT projected:
             -- the customer needs what they agreed to, when, and whether it still
             -- stands — not the operational trail. NULL when nothing was accepted.
             (select json_build_object(
                'accepted_at',        a.accepted_at,
                'kind',               a.kind,
                'accepted_amount',    a.accepted_amount,
                'selected_option_id', a.selected_option_id,
                'document',           a.document,
                'terms_acknowledged', a.terms_acknowledged,
                'terms_text',         a.terms_text,
                'needs_reapproval',
                  public.quote_material_fingerprint(qt.id) is distinct from a.document_fingerprint
              ) from public.quote_acceptances a
              where a.quote_id = qt.id
              order by a.seq desc limit 1) as acceptance
      from public.quotes qt where qt.customer_id = v_customer and qt.user_id = v_user and qt.status <> 'draft') q), '[]'::json),
    -- property_id (NEW): same reason. NULL is the honest answer for a combined
    -- invoice spanning properties — do not infer one.
    -- ⛔ `and status <> 'draft'` IS A PRIVACY PREDICATE, NOT A FILTER PREFERENCE.
    -- A draft is the owner's unfinished, unsent bill. Without this clause it was
    -- serialized into the customer's payload and read straight out of devtools —
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
    -- ⛔⛔ THE INTERNAL ACCESS NOTE IS NOT IN THIS PROJECTION, AND MUST NEVER BE
    -- PUT BACK. jobs.notes is written for whoever DOES the work — the job form
    -- calls it "notes for whoever does the work", crew_day ships it to the
    -- worker's phone as "the access note (gate code, where to park)". It was
    -- selected here and rendered verbatim in the customer's visit history: 49 of
    -- 78 completed production visits carried one, including "dog removal, keep
    -- gate closed". Removing it here kills the leak AT THE SOURCE — a portal
    -- component cannot render what was never serialized.
    -- ⛔ jobs.completion_issue is internal for the same reason and likewise absent.
    -- ⭐ jobs.completion_summary is the CUSTOMER-VISIBLE field, written for the
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

CREATE OR REPLACE FUNCTION public.guard_business_settings_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- current_app_role() treats "has a business_settings row" as PROOF OF OWNERSHIP,
  -- and RLS lets any authenticated user insert a row for their own uid. So this
  -- INSERT was a one-statement promotion from crew to owner (reproduced: role
  -- flipped 'crew' -> 'owner'), which then unlocked the owner-only invite route.
  -- crew_redeem_invite already refuses the reverse direction ("this account owns
  -- a business — it cannot also join one as crew"); this is the missing mirror.
  if exists (select 1 from public.technicians t where t.auth_user_id = new.user_id) then
    raise exception 'this account is linked to an employee record and cannot own a business'
      using errcode = '42501';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_lawn_sqft_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare v_lawn numeric;
begin
  -- Only relevant when lawn_sqft actually changes (cheap: skips every other update).
  if new.lawn_sqft is not distinct from old.lawn_sqft then return new; end if;
  -- Once the typed ledger has a lawn row, its value is the ONLY legitimate
  -- lawn_sqft — which is exactly what the mirror writes. Anything else is a
  -- legacy direct write trying to diverge from the sensor of record.
  select value into v_lawn from public.property_measurements
    where property_id = new.id and kind = 'lawn';
  if found and new.lawn_sqft is distinct from v_lawn then
    raise exception 'lawn_sqft is derived from property_measurements (kind=lawn); save the measurement through lib/measure, never write lawn_sqft directly'
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_technician_auth_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- auth_user_id is the employee's IDENTITY LINK. It may only be written by the
  -- flows that prove consent/ownership: crew_redeem_invite + crew_revoke_access
  -- (SECURITY DEFINER, run as postgres) and the owner-authenticated invite route
  -- (service_role). A client-side write would let an "owner" forge a link to a
  -- stranger's auth account and then have the invite route mint a recovery token
  -- for it.
  if current_user in ('postgres', 'service_role', 'supabase_admin') then return new; end if;
  if tg_op = 'INSERT' and new.auth_user_id is not null then
    raise exception 'auth_user_id is set by the invite/join flow, not written directly'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'auth_user_id is set by the invite/join flow, not written directly'
      using errcode = '42501';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ begin new.updated_at = now(); return new; end; $function$;

CREATE OR REPLACE FUNCTION public.inbox_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  with c as (select archived_at, snoozed_until, lead_status, last_channel, last_direction, unread, muted
             from public.conversations where user_id = auth.uid()),
       awake as (select * from c where archived_at is null and (snoozed_until is null or snoozed_until <= now()))
  select jsonb_build_object(
    'all',          (select count(*) from awake),
    'needs_reply',  (select count(*) from awake where last_direction = 'inbound'),
    'sms',          (select count(*) from awake where lead_status is null and (last_channel = 'sms' or last_channel is null)),
    'portal',       (select count(*) from awake where lead_status is null and last_channel = 'portal'),
    'website_lead', (select count(*) from awake where lead_status = 'new'),
    'snoozed',      (select count(*) from c where archived_at is null and snoozed_until > now()),
    'archived',     (select count(*) from c where archived_at is not null),
    'unread_sum',   (select coalesce(sum(unread), 0) from c where archived_at is null and muted = false)
  );
$function$;
