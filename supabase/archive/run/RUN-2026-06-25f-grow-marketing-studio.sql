-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Grow → Marketing Studio (Phase 0 foundations + Phase 1 schema).
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- The Marketing Studio turns completed jobs into ready-to-post marketing.
-- It reuses everything the app already stores (jobs, job_photos, properties,
-- quotes, business_settings branding) and adds only two new owner-authored
-- tables plus one consent flag. NOTHING here sends, charges, or publishes —
-- generated content stays a draft until the owner copies/posts it. The before/
-- after composite bucket + campaigns/reviews/referrals tables arrive in their
-- own later phases; this migration only creates what Phase 1 actually uses.


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25f — Marketing Studio (Phase 0 + Phase 1)
-- ════════════════════════════════════════════════════════════

-- (1) Photo-marketing consent — DISTINCT from sms_opt_in / email_opt_in.
-- Gates whether a customer's BEFORE/AFTER photos may be used in PUBLIC
-- marketing (a post, flyer, ad). Defaults false: a job is never publishable
-- with identifiable photos until the owner records permission, audited through
-- the SAME consent_changes trail the comms opt-ins use.
alter table public.customers add column if not exists photo_marketing_consent    boolean not null default false;
alter table public.customers add column if not exists photo_marketing_consent_at timestamptz;

-- (2) marketing_assets — one row per postable job. A deterministic scorer
-- (lib/marketing/score.ts) ranks completed jobs+photos live; a row is
-- MATERIALIZED here only when the owner acts on a candidate (generates content,
-- or dismisses it), so the table stays the durable record of "what we've used"
-- without pre-populating every job. The unique (user_id, job_id) lets the
-- Studio upsert idempotently.
create table if not exists public.marketing_assets (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  job_id                uuid not null references public.jobs(id) on delete cascade,
  customer_id           uuid references public.customers(id) on delete set null,
  property_id           uuid references public.properties(id) on delete set null,
  service_type          text,
  neighborhood          text,
  season                text,                                  -- spring | summer | fall | winter
  quality_score         numeric,                               -- deterministic 0-100 at materialize time
  has_before            boolean not null default false,
  has_after             boolean not null default false,
  best_before_photo_id  uuid references public.job_photos(id) on delete set null,
  best_after_photo_id   uuid references public.job_photos(id) on delete set null,
  status                text not null default 'candidate'      -- candidate | used | dismissed
                          check (status in ('candidate','used','dismissed')),
  ai_rationale          text,                                  -- "why this is worth posting"
  archived_at           timestamptz,
  unique (user_id, job_id)
);
alter table public.marketing_assets enable row level security;
-- Owner-only full CRUD (these are the owner's own marketing records — no
-- service-role-only path, unlike payments/website_leads).
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_assets' and policyname='marketing_assets: select own') then
    create policy "marketing_assets: select own" on public.marketing_assets for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_assets' and policyname='marketing_assets: insert own') then
    create policy "marketing_assets: insert own" on public.marketing_assets for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_assets' and policyname='marketing_assets: update own') then
    create policy "marketing_assets: update own" on public.marketing_assets for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketing_assets' and policyname='marketing_assets: delete own') then
    create policy "marketing_assets: delete own" on public.marketing_assets for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists marketing_assets_user_idx     on public.marketing_assets(user_id, created_at desc);
create index if not exists marketing_assets_job_idx      on public.marketing_assets(job_id);
create index if not exists marketing_assets_customer_idx on public.marketing_assets(customer_id);

-- (3) content_pieces — a generated draft for ONE channel. The output of the AI
-- gateway; the owner edits, then copies/downloads/deep-links to publish (v1).
-- asset_id is nullable so future campaign-authored copy can hang off the same
-- table without an asset.
create table if not exists public.content_pieces (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  asset_id        uuid references public.marketing_assets(id) on delete cascade,
  job_id          uuid references public.jobs(id) on delete set null,
  customer_id     uuid references public.customers(id) on delete set null,
  channel         text not null,                               -- facebook|instagram|gbp|nextdoor|linkedin (+ ad/email/sms later)
  kind            text not null default 'organic'              -- organic | ad | print
                    check (kind in ('organic','ad','print')),
  title           text,                                        -- headline / email subject (channel-dependent)
  body            text not null default '',
  hashtags        text[] not null default '{}',
  variant_label   text,
  status          text not null default 'draft'                -- draft | approved | published | scheduled
                    check (status in ('draft','approved','published','scheduled')),
  model           text,                                        -- which Claude model produced it (provenance)
  prompt_version  text,
  scheduled_for   timestamptz,
  published_at    timestamptz,
  external_ref    text,                                        -- platform post id once direct-publish lands
  meta            jsonb not null default '{}'::jsonb
);
alter table public.content_pieces enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='content_pieces' and policyname='content_pieces: select own') then
    create policy "content_pieces: select own" on public.content_pieces for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='content_pieces' and policyname='content_pieces: insert own') then
    create policy "content_pieces: insert own" on public.content_pieces for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='content_pieces' and policyname='content_pieces: update own') then
    create policy "content_pieces: update own" on public.content_pieces for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='content_pieces' and policyname='content_pieces: delete own') then
    create policy "content_pieces: delete own" on public.content_pieces for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists content_pieces_user_idx   on public.content_pieces(user_id, created_at desc);
create index if not exists content_pieces_asset_idx  on public.content_pieces(asset_id);
create index if not exists content_pieces_status_idx on public.content_pieces(user_id, status);

-- (4) updated_at touch triggers (mirror the app convention). Reuse the existing
-- set_updated_at() if present; define a local fallback so this file runs stand-alone.
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end; $fn$;
  end if;
end $$;
drop trigger if exists trg_marketing_assets_updated on public.marketing_assets;
create trigger trg_marketing_assets_updated before update on public.marketing_assets
  for each row execute function public.set_updated_at();
drop trigger if exists trg_content_pieces_updated on public.content_pieces;
create trigger trg_content_pieces_updated before update on public.content_pieces
  for each row execute function public.set_updated_at();

-- (5) Realtime so the Studio + Library reflect generated/saved drafts live
-- (same multiplexed socket the rest of the app uses).
alter table public.marketing_assets replica identity full;
alter table public.content_pieces   replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='marketing_assets') then
    alter publication supabase_realtime add table public.marketing_assets;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='content_pieces') then
    alter publication supabase_realtime add table public.content_pieces;
  end if;
end $$;
