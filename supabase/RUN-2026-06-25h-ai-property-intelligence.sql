-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- AI Property Intelligence ("AI Vision") — the property's AI brain.
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- AI Vision analyses the satellite imagery EdgeQuote already has + any uploaded
-- before/after photos and returns a STRUCTURED, durable read of a property:
-- what's on the ground (mowing/edging/trimming/mulch/rock/weeds/overgrowth/
-- trees/fences/gardens/driveways/obstacles), mowing difficulty, labour /
-- trimming / edging estimates, suggested upsells, and a confidence score.
--
-- It reuses everything already stored (properties, job_photos, customers, the
-- Google Maps key, the Anthropic gateway) and adds ONE owner-scoped table. The
-- analysis is RECOMMENDATIONS ONLY — nothing here writes a price, quote, job or
-- invoice. It is also the durable "brain": future AI tools read the stored
-- analysis (lib/vision/context propertyContextBlock) instead of re-analysing the
-- same imagery, so a property is only ever looked at once per image set.


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-25h — AI Property Intelligence (AI Vision)
-- ════════════════════════════════════════════════════════════

-- (1) property_intelligence — one row per analysis run. A new run SUPERSEDES the
-- prior active row for the same property (status flips to 'superseded'), so the
-- latest active row is always "the current read" while history is preserved for
-- before/after comparisons. image_signature is the reuse key: when the same image
-- set is requested again the app returns the cached row instead of re-billing the
-- model. analysis (jsonb) holds the full structured read; the flat columns beside
-- it are denormalised headline fields so lists/filters never have to parse jsonb.
create table if not exists public.property_intelligence (
  id                 uuid primary key default uuid_generate_v4(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  property_id        uuid not null references public.properties(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete set null,
  job_id             uuid references public.jobs(id) on delete set null,   -- optional: analysis tied to one visit's photos
  source             text not null default 'combined'                      -- satellite | photos | combined
                       check (source in ('satellite','photos','combined')),
  image_count        int  not null default 0,
  image_signature    text,                                                 -- reuse key: which imagery this analysis covers
  -- The reusable brain: the full structured analysis other AI tools read instead
  -- of re-analysing imagery (detections[], estimates, upsells, limitations…).
  analysis           jsonb not null default '{}'::jsonb,
  -- Denormalised headline fields (fast list rendering / filtering, no jsonb parse).
  summary            text,
  detections         text[] not null default '{}',                         -- feature keys detected PRESENT
  upsell_keys        text[] not null default '{}',
  mowing_difficulty  text,                                                  -- easy | moderate | hard | severe
  difficulty_score   numeric,                                              -- 0-100
  est_labour_min     numeric,                                              -- whole-visit labour estimate, minutes
  est_trimming_min   numeric,                                              -- string trimming portion, minutes
  est_edging_ft      numeric,                                              -- linear edging length, feet
  confidence         numeric,                                              -- overall 0-100
  confidence_band    text,                                                 -- high | medium | low (derived from confidence)
  model              text,                                                 -- which Claude model produced it (provenance)
  prompt_version     text,
  status             text not null default 'active'                        -- active | superseded | archived
                       check (status in ('active','superseded','archived'))
);
alter table public.property_intelligence enable row level security;
-- Owner-only full CRUD (the owner's own property analyses — no service-role path).
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_intelligence' and policyname='property_intelligence: select own') then
    create policy "property_intelligence: select own" on public.property_intelligence for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_intelligence' and policyname='property_intelligence: insert own') then
    create policy "property_intelligence: insert own" on public.property_intelligence for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_intelligence' and policyname='property_intelligence: update own') then
    create policy "property_intelligence: update own" on public.property_intelligence for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='property_intelligence' and policyname='property_intelligence: delete own') then
    create policy "property_intelligence: delete own" on public.property_intelligence for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists property_intelligence_user_idx     on public.property_intelligence(user_id, created_at desc);
create index if not exists property_intelligence_property_idx on public.property_intelligence(property_id, status);
create index if not exists property_intelligence_customer_idx on public.property_intelligence(customer_id);

-- (2) updated_at touch trigger (mirror the app convention). Reuse the existing
-- set_updated_at() if present; define a local fallback so this file runs stand-alone.
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end; $fn$;
  end if;
end $$;
drop trigger if exists trg_property_intelligence_updated on public.property_intelligence;
create trigger trg_property_intelligence_updated before update on public.property_intelligence
  for each row execute function public.set_updated_at();

-- (3) Realtime so the Vision panel reflects a finished analysis live
-- (same multiplexed socket the rest of the app uses).
alter table public.property_intelligence replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='property_intelligence') then
    alter publication supabase_realtime add table public.property_intelligence;
  end if;
end $$;
