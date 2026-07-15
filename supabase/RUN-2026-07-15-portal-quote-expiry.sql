-- ── get_portal_data — THE canonical definition ───────────────────────────────
--
-- ⚠️  SOURCE OF TRUTH. Five other files on main also `create or replace` this
--     function, and every one of them is older and NARROWER:
--       RUN-2026-06-25-autopay-website.sql
--       RUN-2026-06-27-invoice-discounts.sql
--       RUN-2026-06-27-payment-ledger.sql
--       RUN-2026-07-07-portal-quote-services.sql
--       RUN-2026-07-09-etransfer-email.sql
--     Running any of them now silently rolls the customer portal backward. Run
--     THIS one. If the function changes, change it HERE.
--
-- This file is the UNION of two lineages that never met in git. On 2026-07-15 the
-- expiry-only version below was applied to production and DELETED the service-plan
-- fields — the portal's plans broke until the union was restored. The two are
-- welded together here so that cannot happen again. Anything replacing this
-- function must carry BOTH lineages.
--
-- ── LINEAGE 1: quote expiry (main) ───────────────────────────────────────────
--
-- WHY
-- Quote expiry (lib/quoteStatus) landed on the OWNER's surfaces only: the quote
-- page, the quote list, and the follow-up cron all honour `valid_until` and stop
-- chasing a lapsed quote. The portal never learned about it — `valid_until` was
-- not in this projection — so the one screen where the price is actually ACTED ON
-- still showed "Awaiting your approval" with a live Accept button for a price the
-- owner had deliberately let lapse. Two screens, same row, opposite stories.
--
-- Expiry is a DISPLAY overlay (see lib/quoteStatus): 'expired' is never written to
-- quotes.status, so there is no second lifecycle to keep in sync and a quote
-- un-expires the instant the owner extends its date. That design is why this fix
-- is a projection change and nothing more — the portal just needs the date so it
-- can derive the same answer the owner's screens already derive.
--
-- WHAT CHANGES
-- `qt.valid_until` is added to the quotes projection. No column is created
-- (quotes.valid_until already exists — nullable date), no data is backfilled, no
-- status is rewritten, and nothing else in the payload moves.
--
-- SAFETY
-- Additive only. A null valid_until means "never expires", which is every quote
-- sent before expiry stamping began — so this cannot retroactively expire
-- anything. Re-runnable (create or replace).
--
-- ── LINEAGE 2: service plans ─────────────────────────────────────────────────
--
-- From RUN-2026-07-14-portal-service-plans.sql, which lives ONLY on
-- guardian/dedup-2026-07-14 and is NOT merged to main — yet IS applied to
-- production. Until that file is merged, this is the only copy of its projection
-- on main.
--
-- The portal was INFERRING a customer's recurring plan from their upcoming jobs,
-- so when a series' scheduled horizon ran out the plan silently vanished — a
-- customer on an active weekly plan was shown nothing. These fields let the portal
-- run the SAME engine the owner's screens run (lib/recurrence.buildServicePlans),
-- so customer and owner can no longer disagree about a plan:
--   business.service_seasons                     — the owner's REAL season window
--   jobs.property_id/quote_id/price/
--       is_initial_visit                         — grouping + initial-vs-recurring price
--   recurrences.start_date/end_count             — the series' window and count limit
--
-- Verified against the live function body (pg_proc.prosrc) on 2026-07-15.

create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    -- review_declined_at: the customer's own "No thanks", so it survives the session.
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in, reviewed_at, review_declined_at, autopay_enabled from public.customers where id = v_customer) c),
    -- service_seasons: buildServicePlans needs the owner's REAL season window.
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, email_secondary, website, logo_url, logo_scale, base_address, terms_text, review_url, coalesce(gst_percent,0) as gst_percent, etransfer_email, service_seasons from public.business_settings where user_id = v_user) b),
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
end; $$;

grant execute on function public.get_portal_data(text) to anon, authenticated;
