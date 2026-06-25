-- ════════════════════════════════════════════════════════════════════════════
-- EdgeQuote — DB CATCH-UP  (audited against the LIVE database, 2026-06-25)
-- ════════════════════════════════════════════════════════════════════════════
-- Contains ONLY objects from schema.sql that are NOT yet in your live database.
-- Every statement is idempotent + additive — safe to run once in the Supabase SQL
-- editor. Run sections top-to-bottom; you may skip OPTIONAL.
--
-- Verified ALREADY APPLIED (NOT included here): AutoPay (2026-06-25c), Website
-- Import (2026-06-25d), Day Settings (2026-06-25), SMS pricing (2026-06-25b), and
-- every core table/column/function/realtime publication the app depends on.
--
-- Superseding notes (two overlapping definitions exist in schema.sql; only the
-- WINNER is included below):
--   • submit_booking      — the 2026-06-23b version (22 args; drafts + lead_meta)
--                            SUPERSEDES the original 17-arg version.
--   • search_conversations — the 2026-06-24h version (property/service match +
--                            lead_status) SUPERSEDES 2026-06-24g's version.
-- ════════════════════════════════════════════════════════════════════════════


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. REQUIRED BEFORE LAUNCH                                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Enables: Website Quote Import owner-token resolution (submit_website_lead) AND
-- the Settings → Booking-link UI that generates the token your website form posts.
-- ⚠ Website lead submissions FAIL at runtime until these two columns exist.
alter table public.business_settings
  add column if not exists booking_enabled boolean not null default false,
  add column if not exists booking_token   text;
create unique index if not exists business_settings_booking_token_idx
  on public.business_settings(booking_token) where booking_token is not null;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. RECOMMENDED                                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 2a. Online Booking / Instant-Quote funnel ───────────────────────────────
-- Powers the implemented public /book/<token> page, src/lib/autoMeasure.ts, and
-- property measurement history. (Section 1 alone is enough for Website Import;
-- run 2a only if you also want the public instant-quote page + auto-measure live.)

create or replace function public.get_booking_business(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare result json;
begin
  select to_json(b) into result from (
    select company_name, owner_name, logo_url, phone, email_primary, website,
           pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate,
           payment_fee_strategy, fee_recovery_percent, gst_percent
    from public.business_settings
    where booking_token = p_token and booking_enabled = true
  ) b;
  return result;
end; $$;
grant execute on function public.get_booking_business(text) to anon, authenticated;

alter table public.quotes add column if not exists lead_meta jsonb;

-- Public upload bucket for booking photos. If your project restricts storage DDL
-- via SQL, create the bucket + these policies in the Storage dashboard instead.
insert into storage.buckets (id, name, public) values ('booking-uploads', 'booking-uploads', true)
  on conflict (id) do nothing;
drop policy if exists "booking_uploads_anon_insert" on storage.objects;
create policy "booking_uploads_anon_insert" on storage.objects for insert to anon with check (bucket_id = 'booking-uploads');
drop policy if exists "booking_uploads_public_read" on storage.objects;
create policy "booking_uploads_public_read" on storage.objects for select to anon, authenticated using (bucket_id = 'booking-uploads');

-- submit_booking (2026-06-23b SUPERSEDES the 17-arg original; drop it if present).
drop function if exists public.submit_booking(text, text, text, text, text, text, text, text, double precision, double precision, numeric, text, numeric, numeric, numeric, numeric, text);
create or replace function public.submit_booking(
  p_token text, p_name text, p_email text, p_phone text,
  p_address text, p_city text, p_province text, p_postal text,
  p_lat double precision, p_lng double precision, p_sqft numeric,
  p_service_type text, p_initial numeric, p_weekly numeric, p_biweekly numeric, p_monthly numeric,
  p_cadence text,
  p_notes text default null, p_hear_about text default null, p_referral_code text default null,
  p_utm jsonb default null, p_photos text[] default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_customer uuid; v_property uuid; v_quote uuid; v_num int; v_qnum text;
        v_source text; v_meta jsonb; v_photo_count int := coalesce(array_length(p_photos, 1), 0);
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  if coalesce(trim(p_name), '') = '' then return null; end if;

  v_source := coalesce(nullif(trim(p_hear_about), ''), nullif(p_utm->>'source', ''), 'Online Booking');
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'hear_about', p_hear_about, 'referral_code', p_referral_code, 'utm', p_utm,
    'photos', to_jsonb(p_photos), 'additional_notes', p_notes));

  insert into public.customers (user_id, name, email, phone, address, city, province, postal_code, acquisition_source, notes)
    values (v_user, left(p_name, 200), nullif(trim(p_email), ''), nullif(trim(p_phone), ''), p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, v_source, nullif(trim(p_notes), ''))
    returning id into v_customer;

  insert into public.properties (user_id, customer_id, address, city, province, postal_code, lat, lng, lawn_sqft, is_primary)
    values (v_user, v_customer, p_address, p_city, coalesce(nullif(p_province, ''), 'AB'), p_postal, p_lat, p_lng, nullif(p_sqft, 0), true)
    returning id into v_property;

  select coalesce(max((regexp_match(quote_number, '([0-9]+)$'))[1]::int), 0) + 1 into v_num
    from public.quotes where user_id = v_user and quote_number like 'EPS-' || extract(year from now())::text || '-%';
  v_qnum := 'EPS-' || extract(year from now())::text || '-' || lpad(v_num::text, 4, '0');

  insert into public.quotes (user_id, quote_number, customer_id, customer_name, address, service_type,
      initial_price, weekly_price, biweekly_price, monthly_price, status, measured_sqft, property_id, notes, lead_meta)
    values (v_user, v_qnum, v_customer, left(p_name, 200), p_address, coalesce(nullif(p_service_type, ''), 'Lawn Mowing'),
      nullif(p_initial, 0), nullif(p_weekly, 0), nullif(p_biweekly, 0), nullif(p_monthly, 0), 'draft', nullif(p_sqft, 0), v_property, nullif(trim(p_notes), ''), v_meta)
    returning id into v_quote;

  insert into public.service_requests (user_id, customer_id, message)
    values (v_user, v_customer, 'New online booking (review) — ' || left(p_name, 80) || ' · ' || coalesce(p_address, '') || ' · ' || coalesce(p_cadence, 'one-time')
      || ' · via ' || v_source || case when v_photo_count > 0 then ' · ' || v_photo_count || ' photo(s)' else '' end
      || case when nullif(trim(p_referral_code), '') is not null then ' · ref:' || p_referral_code else '' end || ' · draft ' || v_qnum);

  return json_build_object('quote_number', v_qnum, 'customer_id', v_customer, 'quote_id', v_quote);
end; $$;
grant execute on function public.submit_booking(text, text, text, text, text, text, text, text, double precision, double precision, numeric, text, numeric, numeric, numeric, numeric, text, text, text, text, jsonb, text[]) to anon, authenticated;

-- Auto-measure store + learning (booking funnel + property measurement history).
create table if not exists public.measurements (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  property_id   uuid references public.properties(id) on delete set null,
  quote_id      uuid references public.quotes(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  lat           double precision,
  lng           double precision,
  neighborhood  text,
  context       text,
  source        text,
  confidence    text,
  building_sqft numeric,
  auto_sqft     numeric,
  accepted_sqft numeric,
  adjusted      boolean,
  diff_pct      numeric
);
alter table public.measurements enable row level security;
drop policy if exists "measurements: select own" on public.measurements;
create policy "measurements: select own" on public.measurements for select using (auth.uid() = user_id);
drop policy if exists "measurements: insert own" on public.measurements;
create policy "measurements: insert own" on public.measurements for insert with check (auth.uid() = user_id);
create index if not exists measurements_user_idx on public.measurements(user_id, created_at desc);
create index if not exists measurements_hood_idx on public.measurements(user_id, neighborhood);

create or replace function public.record_booking_measurement(
  p_token text, p_quote_id uuid, p_lat double precision, p_lng double precision, p_neighborhood text,
  p_auto numeric, p_accepted numeric, p_building numeric, p_confidence text
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return false; end if;
  insert into public.measurements (user_id, quote_id, lat, lng, neighborhood, context, source, confidence,
      building_sqft, auto_sqft, accepted_sqft, adjusted, diff_pct)
    values (v_user, p_quote_id, p_lat, p_lng, nullif(p_neighborhood, ''), 'booking', 'calgary-buildings', nullif(p_confidence, ''),
      nullif(p_building, 0), nullif(p_auto, 0), nullif(p_accepted, 0),
      (p_auto is not null and p_auto > 0 and abs(coalesce(p_accepted, 0) - p_auto) > greatest(1, p_auto * 0.02)),
      case when coalesce(p_auto, 0) > 0 then round(((p_accepted - p_auto) / p_auto * 100)::numeric, 1) else null end);
  return true;
end; $$;
grant execute on function public.record_booking_measurement(text, uuid, double precision, double precision, text, numeric, numeric, numeric, text) to anon, authenticated;

-- ── 2b. Unified schedule items ──────────────────────────────────────────────
-- Referenced by the Messages thread (ConversationInfo) + src/lib/scheduleItems.ts:
-- non-job calendar entries (estimate/callback/appointment/task/reminder).
create table if not exists public.schedule_items (
  id                 uuid primary key default uuid_generate_v4(),
  created_at         timestamptz not null default now(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  type               text not null,
  title              text not null,
  customer_id        uuid references public.customers(id) on delete set null,
  property_id        uuid references public.properties(id) on delete set null,
  scheduled_date     date not null,
  start_time         time,
  duration_minutes   int,
  notes              text,
  phone              text,
  due_at             timestamptz,
  status             text not null default 'scheduled',
  converted_quote_id uuid references public.quotes(id) on delete set null,
  completed_at       timestamptz,
  reminded_at        timestamptz
);
alter table public.schedule_items enable row level security;
drop policy if exists "schedule_items: select own" on public.schedule_items;
create policy "schedule_items: select own" on public.schedule_items for select using (auth.uid() = user_id);
drop policy if exists "schedule_items: insert own" on public.schedule_items;
create policy "schedule_items: insert own" on public.schedule_items for insert with check (auth.uid() = user_id);
drop policy if exists "schedule_items: update own" on public.schedule_items;
create policy "schedule_items: update own" on public.schedule_items for update using (auth.uid() = user_id);
drop policy if exists "schedule_items: delete own" on public.schedule_items;
create policy "schedule_items: delete own" on public.schedule_items for delete using (auth.uid() = user_id);
create index if not exists schedule_items_user_date_idx on public.schedule_items(user_id, scheduled_date);
create index if not exists schedule_items_due_idx on public.schedule_items(user_id, status, due_at);
grant select, insert, update, delete on public.schedule_items to authenticated;
alter table public.schedule_items replica identity full;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_items') then
      execute 'alter publication supabase_realtime add table public.schedule_items';
    end if;
  end if;
end $$;

-- ── 2c. Spotlight search: "Website Lead" badge on search results ─────────────
-- (The inbox badge + Website Leads filter already work without this.)
create or replace function public.search_conversations(p_query text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); q text := '%' || trim(coalesce(p_query, '')) || '%'; result json;
begin
  if v_user is null or length(trim(coalesce(p_query, ''))) < 2 then return '[]'::json; end if;
  select coalesce(json_agg(row_to_json(t) order by t.pinned_at desc nulls last, t.last_message_at desc), '[]'::json) into result
  from (
    select c.id, c.customer_id, c.last_message_at, c.last_preview, c.last_direction, c.unread,
           c.archived_at, c.pinned_at, c.muted, c.lead_status, c.last_channel, cu.name as customer_name, cu.phone as customer_phone,
           (select left(m.body, 140) from public.messages m where m.conversation_id = c.id and m.body ilike q order by m.created_at desc limit 1) as message_snippet,
           case
             when cu.name ilike q then 'name'
             when coalesce(cu.phone, '') ilike q then 'phone'
             when coalesce(cu.address, '') ilike q then 'address'
             when exists (select 1 from public.properties p where p.customer_id = c.customer_id and (coalesce(p.address, '') ilike q or coalesce(p.city, '') ilike q)) then 'property'
             when exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and qq.quote_number ilike q) then 'quote'
             when exists (select 1 from public.invoices iv where iv.customer_id = c.customer_id and iv.invoice_number ilike q) then 'invoice'
             when exists (select 1 from public.jobs j where j.customer_id = c.customer_id and coalesce(j.service_type, '') ilike q)
               or exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and coalesce(qq.service_type, '') ilike q) then 'service'
             else 'message'
           end as match_type
    from public.conversations c
    join public.customers cu on cu.id = c.customer_id
    where c.user_id = v_user and (
      cu.name ilike q or coalesce(cu.phone, '') ilike q or coalesce(cu.address, '') ilike q
      or exists (select 1 from public.properties p where p.customer_id = c.customer_id and (coalesce(p.address, '') ilike q or coalesce(p.city, '') ilike q))
      or exists (select 1 from public.messages m where m.conversation_id = c.id and m.body ilike q)
      or exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and (qq.quote_number ilike q or coalesce(qq.service_type, '') ilike q))
      or exists (select 1 from public.invoices iv where iv.customer_id = c.customer_id and iv.invoice_number ilike q)
      or exists (select 1 from public.jobs j where j.customer_id = c.customer_id and coalesce(j.service_type, '') ilike q)
    )
  ) t;
  return result;
end; $$;
grant execute on function public.search_conversations(text) to authenticated;

-- ── 2d. Security hardening ───────────────────────────────────────────────────
-- Stop anon/authenticated from invoking these SECURITY DEFINER *trigger* functions
-- directly over REST. The triggers themselves keep firing (they run as the table
-- owner), so this is behaviour-preserving — it only closes a direct-call surface.
revoke execute on function public.notify_quote_accepted()        from anon, authenticated;
revoke execute on function public.notify_invoice_paid()          from anon, authenticated;
revoke execute on function public.notify_inbound_message()       from anon, authenticated;
revoke execute on function public.notify_review_received()       from anon, authenticated;
revoke execute on function public.capture_labor_observation()    from anon, authenticated;
revoke execute on function public.push_dispatch()                from anon, authenticated;
revoke execute on function public.bump_conversation()            from anon, authenticated;
revoke execute on function public.sr_to_conversation()           from anon, authenticated;
revoke execute on function public.sync_quote_on_invoice_paid()   from anon, authenticated;
revoke execute on function public.sync_quote_on_job_complete()   from anon, authenticated;
revoke execute on function public.resync_quote_on_job_recurring() from anon, authenticated;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 3. OPTIONAL / FUTURE                                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- 3a. Trigram fuzzy-search indexes — faster name/quote/invoice search once you
--     have thousands of rows. Harmless (just disk) before then.
create extension if not exists pg_trgm;
create index if not exists customers_name_trgm on public.customers using gin (name gin_trgm_ops);
create index if not exists quotes_qnum_trgm     on public.quotes using gin (quote_number gin_trgm_ops);
create index if not exists invoices_inum_trgm   on public.invoices using gin (invoice_number gin_trgm_ops);

-- 3b. Publish properties to realtime (no current code depends on it; consistency
--     with the other core tables only).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='properties') then
    alter publication supabase_realtime add table public.properties;
  end if;
end $$;
