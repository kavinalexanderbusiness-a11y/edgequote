-- ══════════════════════════════════════════════════════════════════════════════
-- Portal: offer the company's OWN services, not a hardcoded lawn menu.
--
-- APPLIED + VERIFIED IN PROD 2026-07-15 (executed against real tokens, not just
-- inspected). This file is the repo's record of what ran — there is no migration
-- ledger in this project.
--
-- WHY: the portal's "Request a service" tab shipped a fixed list — Mulch, Spring
-- Cleanup, Fall Cleanup, Weed Control, Landscaping. A pool company's customers
-- were offered lawn work their company doesn't sell, and could never request the
-- work it does. service_templates is ALREADY the owner's industry-neutral
-- catalogue (name, category, default_rate, pricing_display_type), so this exposes
-- it and ONE portal adapts to whatever the business offers. No new table, no
-- second portal, no industry flag.
--
-- ⚠️ READ BEFORE EDITING get_portal_data ⚠️
-- This function is create-or-replace'd by SEVEN files now. This body was taken
-- from the LIVE function (pg_get_functiondef) immediately before writing, NOT from
-- a repo file — each older file in the chain silently rolls the portal backward.
-- It preserves valid_until, etransfer_email, quote_services, discounts, gst_number
-- and service_seasons. Verify a change by EXECUTING it on a token whose customer
-- has quotes; the text looking right is not evidence.
--
-- (History: the first attempt at this shipped `json_agg(s order by s.sort_order)`
-- where the inline subquery didn't select sort_order → 42703 for EVERY customer,
-- i.e. the whole portal down, not just the new key. Caught by executing it. That
-- is why sort_order is selected below.)
--
-- Additive: clients that don't read `services` are unaffected.
-- ══════════════════════════════════════════════════════════════════════════════
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
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, notes from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (
      select qt.id, qt.quote_number, qt.service_type, qt.address, qt.total, qt.initial_price, qt.subtotal,
             qt.weekly_price, qt.biweekly_price, qt.monthly_price, qt.notes, qt.status, qt.created_at,
             qt.issued_date, qt.crew_size, qt.hours, qt.travel_fee, qt.valid_until,
             coalesce((select json_agg(s order by s.sort_order) from (
               select qs.service_type, qs.quantity, qs.unit, qs.unit_price, qs.est_minutes,
                      qs.discount_type, qs.discount_value, qs.notes, qs.sort_order
               from public.quote_services qs where qs.quote_id = qt.id
             ) s), '[]'::json) as services
      from public.quotes qt where qt.customer_id = v_customer and qt.status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, amount_paid, status, issued_date, due_date, notes, address, line_items, job_id, created_at, discount_type, discount_value from public.invoices where customer_id = v_customer) i), '[]'::json),
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
