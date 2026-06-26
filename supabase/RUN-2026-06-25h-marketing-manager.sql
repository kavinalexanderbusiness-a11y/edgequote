-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Grow → Marketing Studio: "AI social media manager" layer.
-- Idempotent + additive — safe to re-run. Builds ONLY on the Phase 1
-- Marketing Studio tables (RUN-2026-06-25f). Nothing here sends or publishes.
-- ════════════════════════════════════════════════════════════
--
-- Adds a Campaign Builder (one campaign → many posts), a Content Calendar
-- (schedule/drafts/published/failed), and post management (favorite, archive,
-- duplicate, search, filter by platform/campaign/season). All of it organises
-- the SAME content_pieces the generator already produces — no new generation
-- path, no AI plumbing here. Campaigns group CONTENT; they are NOT a revenue-
-- attribution model (analytics rolls revenue up by customers.acquisition_source,
-- deliberately, and never reads this table).


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25h — Marketing manager (campaigns + calendar + library)
-- ════════════════════════════════════════════════════════════

-- (1) marketing_campaigns — a saved theme that fans out into many posts. Each
-- generated post links back via content_pieces.campaign_id so the calendar and
-- the campaign view can show "every post in this campaign" at a glance.
create table if not exists public.marketing_campaigns (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  kind        text not null default 'custom'        -- spring|summer|fall|winter|holiday|rain_delay|referral|review|winback|custom
                check (kind in ('spring','summer','fall','winter','holiday','rain_delay','referral','review','winback','custom')),
  status      text not null default 'draft'          -- draft|active|completed|archived
                check (status in ('draft','active','completed','archived')),
  description text,
  season      text,                                  -- spring|summer|fall|winter (nullable)
  channels    text[] not null default '{}',          -- intended platforms
  starts_on   date,
  ends_on     date,
  meta        jsonb not null default '{}'::jsonb,
  archived_at timestamptz
);
alter table public.marketing_campaigns enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_campaigns' and policyname='marketing_campaigns: select own') then
    create policy "marketing_campaigns: select own" on public.marketing_campaigns for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_campaigns' and policyname='marketing_campaigns: insert own') then
    create policy "marketing_campaigns: insert own" on public.marketing_campaigns for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_campaigns' and policyname='marketing_campaigns: update own') then
    create policy "marketing_campaigns: update own" on public.marketing_campaigns for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_campaigns' and policyname='marketing_campaigns: delete own') then
    create policy "marketing_campaigns: delete own" on public.marketing_campaigns for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists marketing_campaigns_user_idx   on public.marketing_campaigns(user_id, created_at desc);
create index if not exists marketing_campaigns_status_idx on public.marketing_campaigns(user_id, status);

-- (2) content_pieces — manager columns. campaign_id links a post to its campaign;
-- season denormalises the asset's season so the library can filter without a join;
-- favorite/archived_at power the post-management view; the status check grows a
-- 'failed' state for the calendar (a scheduled post that didn't go out).
alter table public.content_pieces add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null;
alter table public.content_pieces add column if not exists season      text;
alter table public.content_pieces add column if not exists favorite    boolean not null default false;
alter table public.content_pieces add column if not exists archived_at timestamptz;

alter table public.content_pieces drop constraint if exists content_pieces_status_check;
alter table public.content_pieces add constraint content_pieces_status_check
  check (status in ('draft','approved','published','scheduled','failed'));

-- Backfill season from the linked asset for posts generated before this column existed.
update public.content_pieces cp
   set season = ma.season
  from public.marketing_assets ma
 where cp.asset_id = ma.id
   and ma.season is not null
   and cp.season is null;

create index if not exists content_pieces_campaign_idx  on public.content_pieces(campaign_id);
create index if not exists content_pieces_schedule_idx  on public.content_pieces(user_id, scheduled_for);
create index if not exists content_pieces_favorite_idx  on public.content_pieces(user_id, favorite) where favorite;
-- Active (non-archived) posts are the common case the library lists first.
create index if not exists content_pieces_active_idx    on public.content_pieces(user_id, created_at desc) where archived_at is null;

-- (3) updated_at touch trigger for campaigns (reuses the shared set_updated_at()).
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end; $fn$;
  end if;
end $$;
drop trigger if exists trg_marketing_campaigns_updated on public.marketing_campaigns;
create trigger trg_marketing_campaigns_updated before update on public.marketing_campaigns
  for each row execute function public.set_updated_at();

-- (4) Realtime so the calendar / campaign view reflect changes live.
alter table public.marketing_campaigns replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='marketing_campaigns') then
    alter publication supabase_realtime add table public.marketing_campaigns;
  end if;
end $$;
