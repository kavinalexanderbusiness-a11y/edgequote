-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- AI Vision → Property Intelligence (the "living digital twin").
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- Builds on RUN-2026-06-25h (property_intelligence). RUN THAT FIRST.
-- ════════════════════════════════════════════════════════════
--
-- This turns AI Vision from one-shot image analysis into a system that
-- ACCUMULATES knowledge about each property over months/years. Two new tables:
--
--   • property_observations — an append-only FACT LOG. Each analysis emits one
--     row per tracked attribute (lawn health, weeds, mulch condition, hedge…),
--     and FUTURE sources (drone imagery, customer uploads, inspection notes,
--     weather history, NDVI scores, other vision models) append here too with a
--     different source_kind. This is the future-proof substrate.
--
--   • property_twin — ONE row per property = the materialized "digital twin":
--     the accumulated memory + the latest computed intelligence (change summary,
--     seasonal recs, maintenance forecast, ranked opportunities, marketing
--     highlights, CRM gaps). Rebuilt from the log on every run.
--
-- Still RECOMMENDATIONS ONLY — nothing here writes a price/quote/job/invoice.
-- Open text columns (source_kind, attribute_key, unit) carry NO check constraint
-- on purpose, so a new modality or model is a new VALUE, never a schema change.


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25i — Property Twin + Observation log
-- ════════════════════════════════════════════════════════════

-- (0) property_intelligence gains per-run provenance for ANY input modality and
-- the capture time of the imagery (distinct from created_at = when we analysed).
alter table public.property_intelligence add column if not exists inputs      jsonb       not null default '[]'::jsonb;  -- [{kind, ref, captured_at, model}]
alter table public.property_intelligence add column if not exists observed_at  timestamptz;                                  -- when the imagery is ABOUT

-- (1) property_observations — the append-only fact log (the twin's substrate).
create table if not exists public.property_observations (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  property_id    uuid not null references public.properties(id) on delete cascade,
  analysis_id    uuid references public.property_intelligence(id) on delete set null, -- the run that produced it (null = external source)
  observed_at    timestamptz not null default now(),     -- when the observation is ABOUT (capture/visit time)
  -- OPEN vocab (no check): vision | satellite | ground_photo | drone | customer_upload
  --                        | inspection_note | weather | ndvi | manual | <future>
  source_kind    text not null default 'vision',
  -- OPEN vocab (no check): lawn_health | weeds | overgrowth | mulch_condition |
  --                        hedge_condition | rock_condition | drainage | irrigation |
  --                        cut_height | edging | lawn_size | difficulty | ndvi | <future>
  attribute_key  text not null,
  value_text     text,                                   -- categorical reading ('faded','overgrown')
  value_num      numeric,                                -- numeric reading (score, %, sqft, ft, ndvi)
  unit           text,                                   -- 'score' | 'pct' | 'sqft' | 'ft' | 'ndvi' | <future>
  confidence     numeric,                                -- 0-100
  model          text,                                   -- provenance ('vision-property-v2', 'claude-opus-4-8', 'drone-v1'…)
  detail         jsonb not null default '{}'::jsonb,     -- coverage, notes, bbox, trouble-spot location…
  status         text not null default 'active' check (status in ('active','archived'))
);
alter table public.property_observations enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_observations' and policyname='property_observations: select own') then
    create policy "property_observations: select own" on public.property_observations for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_observations' and policyname='property_observations: insert own') then
    create policy "property_observations: insert own" on public.property_observations for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_observations' and policyname='property_observations: update own') then
    create policy "property_observations: update own" on public.property_observations for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_observations' and policyname='property_observations: delete own') then
    create policy "property_observations: delete own" on public.property_observations for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists property_observations_prop_idx  on public.property_observations(user_id, property_id, observed_at desc);
create index if not exists property_observations_attr_idx  on public.property_observations(property_id, attribute_key, observed_at desc);
create index if not exists property_observations_run_idx   on public.property_observations(analysis_id);

-- (2) property_twin — ONE row per property = the living digital twin (rollup).
create table if not exists public.property_twin (
  id                  uuid primary key default uuid_generate_v4(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete cascade,
  customer_id         uuid references public.customers(id) on delete set null,
  first_analyzed_at   timestamptz,
  last_analyzed_at    timestamptz,
  analysis_count      int not null default 0,
  latest_analysis_id  uuid references public.property_intelligence(id) on delete set null,
  -- Accumulated MEMORY: attribute_key -> { current, trend, history:[{value, observed_at, source, confidence}], … }
  attributes          jsonb not null default '{}'::jsonb,
  -- Latest computed intelligence (recomputed each run):
  change_summary      jsonb not null default '{}'::jsonb,   -- { narrative, signals:[{kind, attribute, direction, detail}], since }
  seasonal            jsonb not null default '{}'::jsonb,   -- { season, recommendations:[{key,label,why}] }
  forecast            jsonb not null default '{}'::jsonb,   -- { items:[{key,label,predicted_for,basis,confidence}] }
  opportunities       jsonb not null default '{}'::jsonb,   -- { items:[{key,label,tier,score,expected_value,reason,never_purchased}] }
  marketing           jsonb not null default '{}'::jsonb,   -- { flags:[], highlights:[], summary }
  crm                 jsonb not null default '{}'::jsonb,   -- { never_purchased:[], recommendations:[] }
  digest              text,                                 -- human one-paragraph "state of this property"
  model               text,
  prompt_version      text,
  unique (user_id, property_id)
);
alter table public.property_twin enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_twin' and policyname='property_twin: select own') then
    create policy "property_twin: select own" on public.property_twin for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_twin' and policyname='property_twin: insert own') then
    create policy "property_twin: insert own" on public.property_twin for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_twin' and policyname='property_twin: update own') then
    create policy "property_twin: update own" on public.property_twin for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_twin' and policyname='property_twin: delete own') then
    create policy "property_twin: delete own" on public.property_twin for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists property_twin_user_idx     on public.property_twin(user_id, last_analyzed_at desc);
create index if not exists property_twin_property_idx on public.property_twin(property_id);
create index if not exists property_twin_customer_idx on public.property_twin(customer_id);

-- (3) updated_at touch trigger (reuse set_updated_at() if present; local fallback).
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end; $fn$;
  end if;
end $$;
drop trigger if exists trg_property_twin_updated on public.property_twin;
create trigger trg_property_twin_updated before update on public.property_twin
  for each row execute function public.set_updated_at();

-- (4) Realtime so the Vision panel reflects the updated twin live. The observation
-- log is queried on demand (not realtime) — it's append-only history.
alter table public.property_twin replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='property_twin') then
    alter publication supabase_realtime add table public.property_twin;
  end if;
end $$;
