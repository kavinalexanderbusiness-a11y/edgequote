-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715102946
--   name    : portal_get_portal_data_gst_number
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- get_portal_data: add gst_number to the business projection. ONE field added;
-- every other line is the CURRENT live definition, read back with
-- pg_get_functiondef and replayed verbatim.
--
-- Why: the portal re-renders the SAME invoice/receipt PDFs the owner sends, from
-- this payload. Without gst_number the customer's own copy — the one they hand
-- their accountant — carries no GST/HST registration number and cannot support an
-- input tax credit. Fixing it only on the owner's copy would leave the compliance
-- hole on the customer-facing path, which is the copy that actually gets filed.
--
-- NOTE FOR FUTURE SESSIONS: this function has a long file chain. NEVER re-run an
-- older RUN-*.sql that defines it — an earlier file would silently drop the
-- fields added since (valid_until, quote services, kind, is_initial_visit,
-- end_count, review_declined_at...). Always read the live definition first.
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