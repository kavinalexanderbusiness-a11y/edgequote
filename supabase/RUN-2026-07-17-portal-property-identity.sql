-- Portal property identity — ADDITIVE change to get_portal_data.
--
-- WHY. The portal card said "Priced for your measured 10,369 sq ft" on every quote a
-- customer had, because this RPC returned exactly ONE property ('property', limit 1)
-- and the quotes projection carried no property_id at all. A real landlord (6 quotes,
-- 6 properties, 407–10,369 sq ft) saw her PRIMARY property's area on all six cards —
-- the $40 quote for a 407 sq ft lawn claimed 10,369, a 25x overstatement, printed
-- under "What's behind this price" with a green check, on live `sent` quotes. There was
-- no client-side fix available: the other five properties' areas were not in the
-- payload in any form.
--
-- WHAT CHANGED — three ADDITIONS, nothing removed, nothing re-ordered:
--   1. quotes   += property_id   (the canonical FK; the card can now resolve its own property)
--   2. invoices += property_id   (same, and it unblocks per-property invoice grouping)
--   3. 'properties' = the full array, NEW key
--
-- WHAT DELIBERATELY DID NOT CHANGE: 'property' (singular) stays byte-identical —
-- same columns, same `is_primary desc nulls last, created_at asc limit 1` ordering.
-- Several surfaces read it (Home "Your property", PropertyTab, invoice/receipt PDF
-- fallback). Replacing it with the array would have been the same edit twice; leaving
-- it means every existing reader is untouched and this migration cannot regress them.
--
-- This definition was pulled LIVE via pg_get_functiondef immediately before editing
-- (4830 chars) and extended in place. It was NOT reconstructed from an older file:
-- re-running a stale copy of this function is a known production regression here, and
-- a shrinking definition length is the signature of exactly that mistake.
-- Expected: length grows. Verify after applying.

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
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in, reviewed_at, review_declined_at, autopay_enabled from public.customers where id = v_customer) c),
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
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, notes from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    -- NEW — EVERY property this customer owns. `id` is the join key the quotes and
    -- invoices projections below now carry; without it a card cannot name its own
    -- address or area, and 'property' above can only ever answer for the primary.
    -- Same ordering as the singular so properties[0] === property.
    'properties', coalesce((select json_agg(p order by p.is_primary desc nulls last, p.created_at asc) from (
      select id, address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, is_primary, created_at
      from public.properties where customer_id = v_customer
    ) p), '[]'::json),
    -- property_id (NEW): which property this quote is actually for. NULL on legacy
    -- rows (4 of 62 at time of writing) — the client falls back to qt.address text
    -- and suppresses any area claim rather than borrowing the primary's.
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (
      select qt.id, qt.quote_number, qt.service_type, qt.address, qt.property_id, qt.total, qt.initial_price, qt.subtotal,
             qt.weekly_price, qt.biweekly_price, qt.monthly_price, qt.notes, qt.status, qt.created_at,
             qt.issued_date, qt.crew_size, qt.hours, qt.travel_fee, qt.valid_until,
             coalesce((select json_agg(s order by s.sort_order) from (
               select qs.service_type, qs.quantity, qs.unit, qs.unit_price, qs.est_minutes,
                      qs.discount_type, qs.discount_value, qs.notes, qs.sort_order
               from public.quote_services qs where qs.quote_id = qt.id
             ) s), '[]'::json) as services
      from public.quotes qt where qt.customer_id = v_customer and qt.status <> 'draft') q), '[]'::json),
    -- property_id (NEW): same reason. NULL is the honest answer for a combined
    -- invoice spanning properties — do not infer one.
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, amount_paid, status, issued_date, due_date, notes, address, property_id, line_items, job_id, created_at, discount_type, discount_value from public.invoices where customer_id = v_customer) i), '[]'::json),
    'payments', coalesce((select json_agg(pm order by pm.paid_at desc nulls last) from (select id, amount, status, paid_at, provider, kind, invoice_id, created_at from public.payments where customer_id = v_customer and status = 'paid') pm), '[]'::json),
    -- property_id, quote_id, price, is_initial_visit: buildServicePlans groups by
    -- property and uses jobVisitValue to separate initial from recurring price.
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, property_id, quote_id, price, is_initial_visit, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    -- start_date, end_count: the series' own window and count limit.
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, start_date, end_date, end_count from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json),
    'payment_method', (select to_json(pm) from (select brand, last4, exp_month, exp_year from public.payment_methods where customer_id = v_customer and is_default order by created_at desc limit 1) pm)
  ) into result;
  return result;
end; $function$;
