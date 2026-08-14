-- ══════════════════════════════════════════════════════════════════════════════
-- Campaign studio — finishes the CRM campaign engine (crm_campaigns).
--
-- WHY:
--  • Three new campaign kinds the owner asked for: seasonal offers (fire on a
--    fixed calendar date), referral asks, and review chases. `kind` is a CHECK
--    constraint, so widening it needs DDL — schedule/audience are jsonb and need
--    none.
--  • `subject`: every broadcast email currently goes out with the hardcoded
--    subject "A quick hello" because crm_campaigns had nowhere to put one.
--  • `crm_campaign_presets`: a saved campaign configuration the owner can spin
--    up again. Deliberately a SEPARATE table from crm_campaigns — a preset must
--    never be mistaken for a live, sending campaign (it has no `enabled` column,
--    so no cron can ever pick it up).
--
-- Sending is unchanged: the daily cron still resolves an audience and dispatches
-- through lib/comms/dispatch → messages + notification_log. No new send path.
--
-- Additive + idempotent. Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Widen the campaign kinds ──────────────────────────────────────────────
-- Existing rows only ever hold the original four, so no backfill is needed.
alter table public.crm_campaigns
  drop constraint if exists crm_campaigns_kind_check;

alter table public.crm_campaigns
  add constraint crm_campaigns_kind_check
  check (kind in ('birthday','anniversary','win_back','broadcast','seasonal','referral','review'));

-- ── 2. Owner-written email subject ───────────────────────────────────────────
-- Null/blank falls back to the template's stock subject (renderMessage's
-- subjectOverride arg), so existing campaigns are untouched.
alter table public.crm_campaigns
  add column if not exists subject text;

comment on column public.crm_campaigns.subject is
  'Owner-written email subject. Blank → the message template''s built-in subject.';

-- ── 3. Reusable campaign presets ─────────────────────────────────────────────
create table if not exists public.crm_campaign_presets (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('birthday','anniversary','win_back','broadcast','seasonal','referral','review')),
  channels     text[] not null default '{email}',
  template_key text,
  custom_body  text,
  subject      text,
  audience     jsonb not null default '{}'::jsonb,
  schedule     jsonb not null default '{}'::jsonb,
  -- One preset per name per owner: "Save as preset" twice with the same name
  -- updates in place rather than quietly stacking duplicates in the menu.
  unique (user_id, name)
);

alter table public.crm_campaign_presets enable row level security;

drop policy if exists "crm_campaign_presets: select own" on public.crm_campaign_presets;
create policy "crm_campaign_presets: select own" on public.crm_campaign_presets
  for select using (auth.uid() = user_id);

drop policy if exists "crm_campaign_presets: insert own" on public.crm_campaign_presets;
create policy "crm_campaign_presets: insert own" on public.crm_campaign_presets
  for insert with check (auth.uid() = user_id);

drop policy if exists "crm_campaign_presets: update own" on public.crm_campaign_presets;
create policy "crm_campaign_presets: update own" on public.crm_campaign_presets
  for update using (auth.uid() = user_id);

drop policy if exists "crm_campaign_presets: delete own" on public.crm_campaign_presets;
create policy "crm_campaign_presets: delete own" on public.crm_campaign_presets
  for delete using (auth.uid() = user_id);

create index if not exists crm_campaign_presets_user_idx
  on public.crm_campaign_presets(user_id, created_at desc);

drop trigger if exists trg_crm_campaign_presets_updated on public.crm_campaign_presets;
create trigger trg_crm_campaign_presets_updated
  before update on public.crm_campaign_presets
  for each row execute function public.set_updated_at();

-- ── 4. Campaign history / analytics read path ────────────────────────────────
-- The history view lists a campaign's sends newest-first, and the analytics
-- counts group by status. crm_campaign_log already indexes (campaign_id,
-- created_at desc); this adds the status rollup used by the stats loader.
create index if not exists crm_campaign_log_status_idx
  on public.crm_campaign_log(campaign_id, status);
