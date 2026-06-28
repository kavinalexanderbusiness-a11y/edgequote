-- ── Invoice discounts (fixed $ or %) ──────────────────────────────────────────
-- Two nullable columns. invoices.amount stays the NET (post-discount) subtotal, so
-- every existing reader — the Stripe charge routes (checkout / portal pay / autopay),
-- the revenue & outstanding aggregates, and GST via invoiceTotals() — stays correct
-- with no other change. discount_type / discount_value are display + recompute
-- metadata only. Safe to re-run.
alter table public.invoices
  add column if not exists discount_type  text,
  add column if not exists discount_value numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_discount_type_check') then
    alter table public.invoices
      add constraint invoices_discount_type_check
      check (discount_type is null or discount_type in ('amount','percent'));
  end if;
end $$;

-- get_portal_data: also return the invoice discount columns so the customer portal can
-- show the discount in its totals breakdown. Faithful copy of the deployed function
-- with discount_type, discount_value added to the invoices projection (everything else
-- is byte-for-byte the live definition). The charged total is unaffected (amount is the
-- net subtotal). Safe to re-run.
create or replace function public.get_portal_data(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select json_build_object(
    'customer', (select to_json(c) from (select id, name, email, phone, address, city, province, postal_code, sms_opt_in, email_opt_in, reviewed_at, autopay_enabled from public.customers where id = v_customer) c),
    'business', (select to_json(b) from (select company_name, owner_name, phone, email_primary, email_secondary, website, logo_url, logo_scale, base_address, terms_text, review_url, coalesce(gst_percent,0) as gst_percent from public.business_settings where user_id = v_user) b),
    'property', (select to_json(p) from (select address, city, province, postal_code, lawn_sqft, fence_length, neighborhood, notes from public.properties where customer_id = v_customer order by is_primary desc nulls last, created_at asc limit 1) p),
    'quotes', coalesce((select json_agg(q order by q.created_at desc) from (select id, quote_number, service_type, address, total, initial_price, subtotal, weekly_price, biweekly_price, monthly_price, notes, status, created_at, issued_date, crew_size, hours, travel_fee from public.quotes where customer_id = v_customer and status <> 'draft') q), '[]'::json),
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, notes, address, line_items, job_id, created_at, discount_type, discount_value from public.invoices where customer_id = v_customer) i), '[]'::json),
    'payments', coalesce((select json_agg(pm order by pm.paid_at desc nulls last) from (select id, amount, status, paid_at, provider, invoice_id, created_at from public.payments where customer_id = v_customer and status = 'paid') pm), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json),
    'payment_method', (select to_json(pm) from (select brand, last4, exp_month, exp_year from public.payment_methods where customer_id = v_customer and is_default order by created_at desc limit 1) pm)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;
