-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- CRM Automation (Grow → Customer growth automation).
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- This is the "campaigns / reviews / referrals" phase the Marketing Studio
-- migration (2026-06-25f) flagged for later. It adds:
--   (1) a REVIEW LIFECYCLE on top of the existing binary customers.reviewed_at
--       (Not requested → Requested → Reviewed / Declined + source + rating),
--   (2) BIRTHDAY / ANNIVERSARY dates,
--   (3) a denormalised customers.last_contacted_at (maintained from the SAME
--       messages table the comms pipeline already writes) so "not contacted in
--       X days" + win-back are O(1),
--   (4) REFERRAL tracking that BRIDGES the existing referred_by_customer_id link
--       (no customer data is ever duplicated — the referred person is an FK),
--   (5) a customer-centric CAMPAIGN engine (birthday / anniversary / win-back /
--       broadcast) the daily cron drives through the EXISTING comms pipeline.
-- NOTHING here introduces a second comms path, a second review flag, or a copy
-- of any customer record.


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25h — CRM Automation
-- ════════════════════════════════════════════════════════════

-- updated_at touch helper (reuse the app's if present; local fallback so this
-- file runs stand-alone — same pattern as the Marketing Studio migration).
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end; $fn$;
  end if;
end $$;

-- ── (1) Review lifecycle ──────────────────────────────────────────────
-- Extends the existing binary customers.reviewed_at into a full lifecycle
-- WITHOUT a second table. Status is DERIVED in the app (lib/crm/reviews):
--   declined      → review_declined_at is set
--   reviewed      → reviewed_at is set
--   requested     → review_requested_at is set
--   not_requested → none of the above
alter table public.customers add column if not exists review_requested_at timestamptz;
alter table public.customers add column if not exists review_source       text;  -- Google | Facebook | Yelp | Nextdoor | Other
alter table public.customers add column if not exists review_rating        int;   -- 1..5 (nullable)
alter table public.customers add column if not exists review_declined_at   timestamptz;

-- Stamp review_requested_at the first time a review request actually goes out.
-- Driven off notification_log so EVERY send path (manual /api/comms/send AND the
-- cron) promotes the customer to "Requested" with no extra wiring — single source
-- with the comms pipeline. Only a real send (status 'sent') counts, and never
-- once the customer has already reviewed or declined.
create or replace function public.crm_stamp_review_requested()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.template = 'review_request' and new.status = 'sent' and new.customer_id is not null then
    update public.customers
      set review_requested_at = coalesce(review_requested_at, new.created_at)
      where id = new.customer_id and reviewed_at is null and review_declined_at is null;
  end if;
  return new;
end; $$;
drop trigger if exists trg_crm_stamp_review_requested on public.notification_log;
create trigger trg_crm_stamp_review_requested after insert on public.notification_log
  for each row execute function public.crm_stamp_review_requested();

-- Portal self-report also records the source (the portal "leave a review" link is
-- the Google review URL) when not already set. Redefine portal_mark_reviewed
-- (last create-or-replace wins) — the existing notify_review_received trigger on
-- customers still fires off the reviewed_at change.
create or replace function public.portal_mark_reviewed(p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.customers
    set reviewed_at   = coalesce(reviewed_at, now()),
        review_source = coalesce(review_source, 'Google')
    where id = v_customer;
  return true;
end; $$;
grant execute on function public.portal_mark_reviewed(text) to anon, authenticated;

-- ── (2) Birthday / anniversary ────────────────────────────────────────
-- Optional dates that power the birthday / anniversary campaign kinds. Matching
-- is by month+day only (the year is ignored); anniversary may be the customer's
-- start date or any meaningful date the owner records.
alter table public.customers add column if not exists birthday    date;
alter table public.customers add column if not exists anniversary date;

-- ── (3) Contact tracking ──────────────────────────────────────────────
-- Denormalised "last time we reached out", so "not contacted in X days" and the
-- win-back campaign are O(1). Maintained from the SAME messages table the comms
-- pipeline already writes — never a separate log. Only OUTBOUND messages count as
-- a touch (inbound replies and internal notes do not).
alter table public.customers add column if not exists last_contacted_at timestamptz;

create or replace function public.crm_touch_last_contacted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'outbound' and new.customer_id is not null then
    update public.customers
      set last_contacted_at = greatest(coalesce(last_contacted_at, '-infinity'::timestamptz), new.created_at)
      where id = new.customer_id;
  end if;
  return new;
end; $$;
drop trigger if exists trg_crm_touch_last_contacted on public.messages;
create trigger trg_crm_touch_last_contacted after insert on public.messages
  for each row execute function public.crm_touch_last_contacted();

-- One-time backfill from existing outbound messages (safe to re-run — recomputes
-- the max and only moves the value forward).
update public.customers c
  set last_contacted_at = sub.mx
  from (
    select customer_id, max(created_at) as mx
    from public.messages where direction = 'outbound' and customer_id is not null
    group by customer_id
  ) sub
  where sub.customer_id = c.id
    and (c.last_contacted_at is null or c.last_contacted_at < sub.mx);

-- ── (4) Referral tracking ─────────────────────────────────────────────
-- The ACT of referring + its outcome. The referred person is referenced by FK
-- (referred_customer_id) once they become a customer — NEVER copied. A not-yet
-- customer referral keeps only a name/contact until they convert.
create table if not exists public.referrals (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  referrer_customer_id uuid not null references public.customers(id) on delete cascade,
  referred_customer_id uuid references public.customers(id) on delete set null,
  referred_name        text,
  referred_contact     text,
  status               text not null default 'invited'
                         check (status in ('invited','joined','rewarded','declined')),
  reward               text,
  notes                text,
  joined_at            timestamptz,
  rewarded_at          timestamptz
);
alter table public.referrals enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referrals' and policyname='referrals: select own') then
    create policy "referrals: select own" on public.referrals for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referrals' and policyname='referrals: insert own') then
    create policy "referrals: insert own" on public.referrals for insert with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referrals' and policyname='referrals: update own') then
    create policy "referrals: update own" on public.referrals for update using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referrals' and policyname='referrals: delete own') then
    create policy "referrals: delete own" on public.referrals for delete using (auth.uid() = user_id); end if;
end $$;
create index if not exists referrals_user_idx     on public.referrals(user_id, created_at desc);
create index if not exists referrals_referrer_idx on public.referrals(referrer_customer_id);
create index if not exists referrals_referred_idx on public.referrals(referred_customer_id);
-- One referral row per (referrer, referred customer) so the bridge upsert below
-- is idempotent. Partial — pending (no referred_customer_id) rows are unconstrained.
create unique index if not exists referrals_link_uniq
  on public.referrals(referrer_customer_id, referred_customer_id)
  where referred_customer_id is not null;

drop trigger if exists trg_referrals_updated on public.referrals;
create trigger trg_referrals_updated before update on public.referrals
  for each row execute function public.set_updated_at();

-- Bridge the EXISTING referred_by_customer_id link into the tracker: whenever a
-- customer points at a referrer, ensure a 'joined' referral row exists. This
-- surfaces every existing referral relationship without re-entering anything,
-- and upgrades a prior 'invited' row to 'joined' when the prospect converts.
create or replace function public.crm_sync_referral()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.referred_by_customer_id is not null
     and new.referred_by_customer_id <> new.id
     and (TG_OP = 'INSERT' or new.referred_by_customer_id is distinct from old.referred_by_customer_id) then
    insert into public.referrals (user_id, referrer_customer_id, referred_customer_id, referred_name, status, joined_at)
      values (new.user_id, new.referred_by_customer_id, new.id, new.name, 'joined', coalesce(new.created_at, now()))
      on conflict (referrer_customer_id, referred_customer_id) where referred_customer_id is not null
      do update set status    = case when referrals.status = 'invited' then 'joined' else referrals.status end,
                    joined_at = coalesce(referrals.joined_at, excluded.joined_at);
  end if;
  return new;
end; $$;
drop trigger if exists trg_crm_sync_referral on public.customers;
create trigger trg_crm_sync_referral after insert or update of referred_by_customer_id on public.customers
  for each row execute function public.crm_sync_referral();

-- One-time backfill of existing referred_by links into the tracker.
insert into public.referrals (user_id, referrer_customer_id, referred_customer_id, referred_name, status, joined_at)
  select c.user_id, c.referred_by_customer_id, c.id, c.name, 'joined', c.created_at
  from public.customers c
  where c.referred_by_customer_id is not null and c.referred_by_customer_id <> c.id
  on conflict (referrer_customer_id, referred_customer_id) where referred_customer_id is not null do nothing;

-- ── (5) Campaign engine ───────────────────────────────────────────────
-- Customer-CENTRIC automated outreach, DISTINCT from the job-triggered
-- business_settings.automations (reminder / job_complete / review). One row per
-- campaign the owner defines; the daily cron (/api/cron/campaigns) resolves the
-- audience, renders via the SAME templates, and sends through the SAME comms
-- pipeline (messages + notification_log). crm_campaign_log dedupes per period.
create table if not exists public.crm_campaigns (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  kind          text not null check (kind in ('birthday','anniversary','win_back','broadcast')),
  enabled       boolean not null default false,
  channels      text[] not null default '{sms,email}',
  template_key  text,                                  -- a comms MsgType, or null when custom_body is used
  custom_body   text,                                  -- owner copy (overrides template); {{first_name}} etc. still interpolate
  audience      jsonb not null default '{}'::jsonb,    -- { recurring_only?: bool }
  schedule      jsonb not null default '{}'::jsonb,    -- win_back {days}; broadcast {day_of_month, every_months}; birthday/anniversary {lead_days}
  last_run_at   timestamptz
);
alter table public.crm_campaigns enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaigns' and policyname='crm_campaigns: select own') then
    create policy "crm_campaigns: select own" on public.crm_campaigns for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaigns' and policyname='crm_campaigns: insert own') then
    create policy "crm_campaigns: insert own" on public.crm_campaigns for insert with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaigns' and policyname='crm_campaigns: update own') then
    create policy "crm_campaigns: update own" on public.crm_campaigns for update using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaigns' and policyname='crm_campaigns: delete own') then
    create policy "crm_campaigns: delete own" on public.crm_campaigns for delete using (auth.uid() = user_id); end if;
end $$;
create index if not exists crm_campaigns_user_idx on public.crm_campaigns(user_id, enabled);
drop trigger if exists trg_crm_campaigns_updated on public.crm_campaigns;
create trigger trg_crm_campaigns_updated before update on public.crm_campaigns
  for each row execute function public.set_updated_at();

-- Per-send dedupe + history. The cron writes one row per (campaign, customer,
-- period_key); the unique constraint guarantees a campaign fires at most once per
-- customer per period (a year for birthday/anniversary, a month for
-- broadcast/win-back). Service-role writes from the cron; owner reads in the UI.
create table if not exists public.crm_campaign_log (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  campaign_id  uuid not null references public.crm_campaigns(id) on delete cascade,
  customer_id  uuid not null references public.customers(id) on delete cascade,
  period_key   text not null,
  channel      text,
  status       text,
  detail       text,
  message_id   uuid references public.messages(id) on delete set null,
  unique (campaign_id, customer_id, period_key)
);
alter table public.crm_campaign_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaign_log' and policyname='crm_campaign_log: select own') then
    create policy "crm_campaign_log: select own" on public.crm_campaign_log for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='crm_campaign_log' and policyname='crm_campaign_log: insert own') then
    create policy "crm_campaign_log: insert own" on public.crm_campaign_log for insert with check (auth.uid() = user_id); end if;
end $$;
create index if not exists crm_campaign_log_campaign_idx on public.crm_campaign_log(campaign_id, created_at desc);
create index if not exists crm_campaign_log_customer_idx on public.crm_campaign_log(customer_id);

-- ── (6) Realtime (live UI; same multiplexed socket as the rest of the app) ──
alter table public.referrals        replica identity full;
alter table public.crm_campaigns    replica identity full;
alter table public.crm_campaign_log replica identity full;
do $$ begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='referrals') then
      alter publication supabase_realtime add table public.referrals; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='crm_campaigns') then
      alter publication supabase_realtime add table public.crm_campaigns; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='crm_campaign_log') then
      alter publication supabase_realtime add table public.crm_campaign_log; end if;
  end if;
end $$;
