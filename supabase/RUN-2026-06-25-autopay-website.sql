-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- AutoPay (2026-06-25c) + Website Quote Import (2026-06-25d).
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25c — Recurring card-on-file AutoPay (Stripe SetupIntents)
-- ════════════════════════════════════════════════════════════
-- Card-on-file + per-customer AutoPay layered onto the EXISTING payment pipeline:
-- the SAME payments table, the SAME Stripe webhook, the SAME invoice paid-flip.
-- We store ONLY Stripe ids + display metadata (brand/last4/expiry) — never a card
-- number; Stripe holds the card. Fully additive + idempotent: every existing
-- customer starts autopay_enabled=false, so NOTHING auto-charges until a card is
-- saved AND AutoPay is turned on. One-time payment links are untouched.

-- (1) Stripe customer ref + AutoPay flags on customers.
alter table public.customers add column if not exists stripe_customer_id text;
alter table public.customers add column if not exists autopay_enabled boolean not null default false;
-- Per-customer charge-mode OVERRIDE: null = inherit the business default;
-- 'auto' = charge automatically on recurring completion; 'manual_review' = always
-- hold the draft for the owner to charge.
alter table public.customers add column if not exists autopay_charge_mode text
  check (autopay_charge_mode in ('auto','manual_review'));

-- (2) Business-level AutoPay default + the anomaly safety threshold.
alter table public.business_settings add column if not exists autopay_charge_mode text
  not null default 'auto' check (autopay_charge_mode in ('auto','manual_review'));
-- A recurring invoice whose amount deviates from the customer's usual recurring
-- amount by MORE than this percent is HELD for manual review instead of being
-- auto-charged (the safety check). Default 40%.
alter table public.business_settings add column if not exists autopay_variance_pct int not null default 40;

-- (3) Saved payment methods — card DISPLAY metadata only; Stripe holds the card.
create table if not exists public.payment_methods (
  id                        uuid primary key default uuid_generate_v4(),
  created_at                timestamptz not null default now(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  customer_id               uuid not null references public.customers(id) on delete cascade,
  stripe_customer_id        text,
  stripe_payment_method_id  text not null unique,   -- idempotency: one row per saved card
  brand                     text,
  last4                     text,
  exp_month                 int,
  exp_year                  int,
  is_default                boolean not null default true
);
alter table public.payment_methods enable row level security;
-- Owner reads their own saved cards. Writes happen ONLY via the service-role
-- webhook (save) and server routes (remove) — there is deliberately NO anon/auth
-- insert/update policy, mirroring the payments table, so nothing client-side can
-- fabricate or alter a saved card.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_methods' and policyname='payment_methods: select own') then
    create policy "payment_methods: select own" on public.payment_methods for select using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists payment_methods_customer_idx on public.payment_methods(customer_id, is_default desc, created_at desc);

-- (4) Realtime so the profile card + portal reflect a saved/removed card live.
alter table public.payment_methods replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='payment_methods') then
    alter publication supabase_realtime add table public.payment_methods;
  end if;
end $$;

-- (5) Portal: token-scoped AutoPay toggle. Only flips the per-customer flag for the
-- token's customer; enabling is a no-op safeguard if no card is on file.
create or replace function public.portal_set_autopay(p_token text, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_has_card boolean;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  if p_enabled then
    select exists(select 1 from public.payment_methods where customer_id = v_customer) into v_has_card;
    if not v_has_card then return false; end if;   -- can't enable AutoPay with no card
  end if;
  update public.customers set autopay_enabled = p_enabled where id = v_customer;
  return true;
end; $$;
grant execute on function public.portal_set_autopay(text, boolean) to anon, authenticated;

-- (6) Portal: resolve the token's customer + (lazily-created) Stripe ids so the
-- server route can mint a SetupIntent Checkout. Returns nulls-safe json; the route
-- persists a freshly-created stripe_customer_id back via the service role.
create or replace function public.portal_begin_setup(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_user uuid; result json;
begin
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select to_json(c) into result from (
    select id, user_id, name, email, stripe_customer_id from public.customers where id = v_customer
  ) c;
  return result;
end; $$;
grant execute on function public.portal_begin_setup(text) to anon, authenticated;

-- (7) Portal: remove the saved card. Deletes the metadata rows for the token's
-- customer and disables AutoPay (can't autopay with no card), returning the Stripe
-- payment_method id(s) so the route can detach them from Stripe.
create or replace function public.portal_remove_card(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_pms json;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return null; end if;
  select coalesce(json_agg(stripe_payment_method_id), '[]'::json) into v_pms
    from public.payment_methods where customer_id = v_customer;
  delete from public.payment_methods where customer_id = v_customer;
  update public.customers set autopay_enabled = false where id = v_customer;
  return v_pms;
end; $$;
grant execute on function public.portal_remove_card(text) to anon, authenticated;

-- (8) get_portal_data refreshed AGAIN (last create-or-replace wins): adds
-- customer.autopay_enabled + a top-level payment_method summary so the portal can
-- render the saved card + AutoPay state from the same token-scoped read.
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
    'invoices', coalesce((select json_agg(i order by i.created_at desc) from (select id, invoice_number, service_type, amount, status, issued_date, due_date, notes, address, line_items, job_id, created_at from public.invoices where customer_id = v_customer) i), '[]'::json),
    'payments', coalesce((select json_agg(pm order by pm.paid_at desc nulls last) from (select id, amount, status, paid_at, provider, invoice_id, created_at from public.payments where customer_id = v_customer and status = 'paid') pm), '[]'::json),
    'jobs', coalesce((select json_agg(j order by j.scheduled_date desc) from (select id, recurrence_id, service_type, title, scheduled_date, status, on_my_way_at, started_at, completed_at, notes from public.jobs where customer_id = v_customer and status <> 'cancelled' order by scheduled_date desc limit 200) j), '[]'::json),
    'recurrences', coalesce((select json_agg(r) from (select id, freq, interval_unit, interval_count, end_date from public.job_recurrences where customer_id = v_customer) r), '[]'::json),
    'photos', coalesce((select json_agg(p order by p.taken_at desc) from (select id, job_id, storage_path, kind, caption, taken_at from public.job_photos where customer_id = v_customer) p), '[]'::json),
    'payment_method', (select to_json(pm) from (select brand, last4, exp_month, exp_year from public.payment_methods where customer_id = v_customer and is_default order by created_at desc limit 1) pm)
  ) into result;
  return result;
end; $$;
grant execute on function public.get_portal_data(text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25d — Website Quote Import (leads folded into Messages)
-- ════════════════════════════════════════════════════════════
-- A website quote-form submission becomes a CONVERSATION in the existing unified
-- inbox (one hub — no separate leads page): a durable website_leads audit row keeps
-- the raw submission + structured fields, the customer is de-duplicated (phone →
-- email → address) or created, and the lead lands as an inbound message via the SAME
-- service_requests → sr_to_conversation path portal requests use. The conversation is
-- tagged lead_status='new' (the "Website Lead" badge + filter); building a quote
-- clears it and the thread continues normally. Additive + idempotent.

-- (1) Conversation typing for the inbox filters/badge.
--   lead_status:  null | 'new' (an OPEN website lead). Mutable — cleared when quoted.
--   last_channel: the most-recent message channel, maintained by bump_conversation,
--   so the SMS / Portal chips are a single-column predicate (no per-row EXISTS).
alter table public.conversations add column if not exists lead_status  text;
alter table public.conversations add column if not exists last_channel text;
create index if not exists conversations_lead_idx on public.conversations(user_id, lead_status) where lead_status is not null;

-- bump_conversation now also tracks last_channel (keeps the prior auto-unarchive +
-- summary behaviour). Last create-or-replace wins.
create or replace function public.bump_conversation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = new.created_at,
    last_preview    = left(new.body, 140),
    last_direction  = new.direction,
    last_channel    = new.channel,
    unread          = case when new.direction = 'inbound' then unread + 1 else unread end,
    archived_at     = case when new.direction in ('inbound','outbound') then null else archived_at end
  where id = new.conversation_id;
  return new;
end; $$;

-- Backfill last_channel from each conversation's most recent message (one-time).
update public.conversations c set last_channel = m.channel
from (
  select distinct on (conversation_id) conversation_id, channel
  from public.messages order by conversation_id, created_at desc
) m
where m.conversation_id = c.id and c.last_channel is null;

-- (2) Property geometry the website measures — persisted PERMANENTLY on the property.
alter table public.properties add column if not exists lawn_polygon                jsonb;
alter table public.properties add column if not exists google_place_id             text;
alter table public.properties add column if not exists maps_url                     text;
alter table public.properties add column if not exists property_travel_distance_km  numeric;
alter table public.properties add column if not exists property_travel_fee          numeric;

-- (3) Durable website-lead audit table. The RAW submission is preserved for
-- debugging; the structured columns are the UI projection. Owner-only RLS; NO anon
-- access — rows are written exclusively by the SECURITY DEFINER intake RPC below.
create table if not exists public.website_leads (
  id                      uuid primary key default uuid_generate_v4(),
  created_at              timestamptz not null default now(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  customer_id             uuid references public.customers(id) on delete set null,
  conversation_id         uuid references public.conversations(id) on delete set null,
  quote_id                uuid references public.quotes(id) on delete set null,
  status                  text not null default 'new',   -- new | quoted | dismissed
  raw_submission          jsonb not null,                -- the exact website POST, for audit
  submitted_at            timestamptz,                   -- the website's own timestamp
  contact_first           text,
  contact_last            text,
  contact_name            text,
  phone                   text,
  email                   text,
  preferred_contact       text,
  address                 text,
  city                    text,
  province                text,
  postal_code             text,
  place_id                text,
  maps_url                text,
  lat                     double precision,
  lng                     double precision,
  lawn_sqft               numeric,
  lawn_polygon            jsonb,
  sections                jsonb,
  travel_distance_km      numeric,
  travel_fee              numeric,
  requested_services      text,
  frequency               text,
  yard_condition          text,
  website_estimated_price numeric,
  notes                   text
);
alter table public.website_leads enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='website_leads' and policyname='website_leads: select own') then
    create policy "website_leads: select own" on public.website_leads for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='website_leads' and policyname='website_leads: update own') then
    create policy "website_leads: update own" on public.website_leads for update using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists website_leads_user_idx     on public.website_leads(user_id, created_at desc);
create index if not exists website_leads_customer_idx on public.website_leads(customer_id);

-- Realtime so the inbox lead badge appears live.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='website_leads') then
    alter publication supabase_realtime add table public.website_leads;
  end if;
end $$;

-- (4) Public intake RPC. The website POSTs its submission as jsonb + the owner's
-- booking_token. Resolves the owner, de-duplicates the customer (phone → email →
-- address), creates the customer + a primary property when new, writes the durable
-- website_leads row, and threads the lead into Messages by inserting ONE
-- service_request (which fires sr_to_conversation → conversation + inbound message +
-- bell). The conversation is tagged lead_status='new'. Returns {lead_id, customer_id}.
create or replace function public.submit_website_lead(p_token text, p_payload jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_customer uuid; v_prop uuid; v_lead uuid; v_convo uuid;
  v_phone text; v_email text; v_name text; v_first text; v_last text; v_address text;
  v_digits text; v_summary text; v_services text;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;

  v_first    := nullif(trim(coalesce(p_payload->>'firstName', p_payload->>'first_name', '')), '');
  v_last     := nullif(trim(coalesce(p_payload->>'lastName',  p_payload->>'last_name',  '')), '');
  v_name     := nullif(trim(coalesce(p_payload->>'fullName',  p_payload->>'name', concat_ws(' ', v_first, v_last))), '');
  v_phone    := nullif(trim(coalesce(p_payload->>'phone', '')), '');
  v_email    := lower(nullif(trim(coalesce(p_payload->>'email', '')), ''));
  v_address  := nullif(trim(coalesce(p_payload->>'address', p_payload->>'serviceAddress', '')), '');
  v_services := nullif(trim(coalesce(p_payload->>'requestedServices', p_payload->>'services', p_payload->>'serviceType', '')), '');

  -- DEDUP customer: phone (last 10) → email → address; else create new.
  v_digits := right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10);
  if length(v_digits) = 10 then
    select id into v_customer from public.customers
      where user_id = v_user and phone is not null
        and right(regexp_replace(phone, '\D', '', 'g'), 10) = v_digits
      order by created_at desc limit 1;
  end if;
  if v_customer is null and v_email is not null then
    select id into v_customer from public.customers
      where user_id = v_user and lower(coalesce(email, '')) = v_email order by created_at desc limit 1;
  end if;
  if v_customer is null and v_address is not null then
    select id into v_customer from public.customers
      where user_id = v_user and lower(coalesce(address, '')) = lower(v_address) order by created_at desc limit 1;
  end if;

  if v_customer is null then
    insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source)
    values (v_user, coalesce(v_name, 'Website lead'), v_email, v_phone, v_address,
            nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
            nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
            'Website')
    returning id into v_customer;
  else
    update public.customers set
      phone = coalesce(phone, v_phone),
      email = coalesce(email, v_email)
    where id = v_customer;
  end if;

  -- Property: reuse a matching one, else create a primary. Persist website geometry
  -- ONLY when creating a NEW property — never silently overwrite a measured lawn
  -- (Build Quote handles updating an existing lawn with explicit confirmation).
  select id into v_prop from public.properties
    where customer_id = v_customer and v_address is not null and lower(coalesce(address, '')) = lower(v_address)
    order by is_primary desc nulls last, created_at asc limit 1;
  if v_prop is null then
    insert into public.properties (
      customer_id, user_id, address, city, province, postal_code, lat, lng,
      lawn_sqft, lawn_polygon, google_place_id, maps_url, property_travel_distance_km, property_travel_fee, is_primary
    ) values (
      v_customer, v_user, coalesce(v_address, 'Website lead'),
      nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
      nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
      nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
      nullif(coalesce(p_payload->>'lawnSqft', p_payload->>'lawn_sqft'), '')::numeric,
      p_payload->'polygon',
      nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
      nullif(coalesce(p_payload->>'mapsUrl', p_payload->>'maps_url'), ''),
      nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
      nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric,
      not exists (select 1 from public.properties where customer_id = v_customer)
    ) returning id into v_prop;
  end if;

  -- Durable audit + structured projection.
  insert into public.website_leads (
    user_id, customer_id, status, raw_submission, submitted_at,
    contact_first, contact_last, contact_name, phone, email, preferred_contact,
    address, city, province, postal_code, place_id, maps_url, lat, lng,
    lawn_sqft, lawn_polygon, sections, travel_distance_km, travel_fee,
    requested_services, frequency, yard_condition, website_estimated_price, notes
  ) values (
    v_user, v_customer, 'new', p_payload, nullif(p_payload->>'submittedAt', '')::timestamptz,
    v_first, v_last, v_name, v_phone, v_email, nullif(p_payload->>'preferredContact', ''),
    v_address, nullif(p_payload->>'city', ''), coalesce(nullif(p_payload->>'province', ''), 'AB'),
    nullif(coalesce(p_payload->>'postalCode', p_payload->>'postal_code'), ''),
    nullif(coalesce(p_payload->>'placeId', p_payload->>'place_id'), ''),
    nullif(coalesce(p_payload->>'mapsUrl', p_payload->>'maps_url'), ''),
    nullif(p_payload->>'lat', '')::double precision, nullif(p_payload->>'lng', '')::double precision,
    nullif(coalesce(p_payload->>'lawnSqft', p_payload->>'lawn_sqft'), '')::numeric,
    p_payload->'polygon', p_payload->'sections',
    nullif(coalesce(p_payload->>'travelDistanceKm', p_payload->>'travel_distance_km'), '')::numeric,
    nullif(coalesce(p_payload->>'travelFee', p_payload->>'travel_fee'), '')::numeric,
    v_services, nullif(p_payload->>'frequency', ''), nullif(p_payload->>'yardCondition', ''),
    nullif(p_payload->>'estimatedPrice', '')::numeric, nullif(p_payload->>'notes', '')
  ) returning id into v_lead;

  -- Thread into Messages via the SAME path portal requests use (one get-or-create).
  v_summary := 'New website quote request'
    || case when v_services is not null then ' — ' || v_services else '' end
    || case when nullif(p_payload->>'lawnSqft', '') is not null then ' · ' || (p_payload->>'lawnSqft') || ' ft² lawn' else '' end
    || case when nullif(p_payload->>'estimatedPrice', '') is not null then ' · est. $' || (p_payload->>'estimatedPrice') else '' end;
  insert into public.service_requests (user_id, customer_id, message, status)
    values (v_user, v_customer, v_summary, 'new');

  -- Tag the conversation as an OPEN website lead + link the lead row to it.
  update public.conversations set lead_status = 'new'
    where user_id = v_user and customer_id = v_customer;
  select id into v_convo from public.conversations where user_id = v_user and customer_id = v_customer limit 1;
  update public.website_leads set conversation_id = v_convo where id = v_lead;

  return json_build_object('lead_id', v_lead, 'customer_id', v_customer);
end; $$;
grant execute on function public.submit_website_lead(text, jsonb) to anon, authenticated;
