-- ═══════════════════════════════════════════════════════════════════════════
-- PRICE BOOK V1 — the catalogue learns to state a DURATION and a CREW
--
-- Session 76. Two nullable columns on the catalogue that already exists.
--
-- ⚠️⚠️ RE-VERSIONED 20260815120000 → 20260817120000 (Session 76 reconciliation).
-- The original version was a COLLISION: production's ledger already records
-- `20260815120000` as **job_forms_v1** (Session 69, sql_len 56289,
-- sql_md5 ee82282896147da50370de7507a3ddc0). Shipping this file under that
-- version would have made two different bodies claim one version — and because
-- `supabase_migrations.schema_migrations` keys on the version, the second one
-- would simply never apply while every hygiene check reported it as shipped.
-- It also sorted BEFORE the current generated baseline (20260816110001), which
-- on a from-zero rebuild means altering a table that does not exist yet.
-- The new version sorts after the applied floor (20260817060000 worker_access_v1)
-- and after the baseline. ⛔ Do NOT restore the old number to 'match' anything.
--
-- ⛔ THERE IS NO NEW TABLE, AND THERE IS DELIBERATELY NO NEW PRICING ENGINE.
-- `service_templates` has BEEN the price book since the product had one: it owns
-- `name`, `category`, `default_rate`, `pricing_display_type`, `default_description`,
-- `unit_cost`, `material_cost`, `is_favorite`, `is_active` and `recurrence`. A
-- second "price_book" table would be a second catalogue, and this repo has already
-- paid for that mistake once (three different objects all called a "follow-up").
-- The only thing an owner could not record here was HOW LONG the work takes and
-- HOW MANY PEOPLE it needs — so those, and nothing else, are what this adds.
--
-- ⭐⭐ NULL MEANS "NOT STATED". IT DOES NOT MEAN ZERO.
-- Both columns are nullable with no default, and both CHECKs permit NULL. A zero
-- would be a claim — "this job takes no time", "this job needs nobody" — and every
-- duration consumer in the codebase already reads `> 0` as the test for a real
-- figure (lib/dayFit resolveDuration, quote_services.est_minutes, the builder's
-- `Number(s.est_minutes) > 0`). Storing 0 for "we haven't said" would make the
-- catalogue's silence arithmetically indistinguishable from an instant job.
--
-- ⭐ WHY NO DEFAULT VALUE. Seeding a number would be inventing evidence. The
-- trades catalogue (lib/trades/catalog.ts) was drafted and adversarially reviewed
-- per trade for RATES; nobody has reviewed durations for 12 trades, and a made-up
-- 60 minutes on 120 seed rows would immediately start feeding the day planner
-- claims no one measured. An owner types these, or they stay silent.
--
-- ⛔ THIS MIGRATION DOES NOT TOUCH MONEY. No column here is read by any pricing
-- path, no trigger is added, and `quotes.total` is not referenced. A duration and
-- a crew size are operational facts; the rate this catalogue already owned is
-- unchanged in both meaning and value.
--
-- RLS: none needed. Columns added to an existing table are covered by that
-- table's existing policies — `service_templates` is already tenant-scoped by
-- user_id, and adding a column cannot widen a policy.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public."service_templates"
  add column if not exists "default_minutes" integer,
  add column if not exists "default_crew_size" integer;

-- Upper bounds are sanity rails, not policy. 100000 minutes is ~10 working weeks
-- — past any single service scope, and well clear of the multi-day projects
-- lib/workEstimate is built to describe honestly. 50 workers is far beyond the
-- small-crew businesses this product serves; both exist so a fat-fingered entry
-- cannot quietly poison capacity planning.
do $$ begin
  alter table public."service_templates"
    add constraint "service_templates_default_minutes_check"
    check ("default_minutes" is null or ("default_minutes" > 0 and "default_minutes" <= 100000));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public."service_templates"
    add constraint "service_templates_default_crew_size_check"
    check ("default_crew_size" is null or ("default_crew_size" >= 1 and "default_crew_size" <= 50));
exception when duplicate_object then null; end $$;

comment on column public."service_templates"."default_minutes" is
  'Catalogue DEFAULT on-site elapsed minutes for this service. NULL = not stated (never 0). '
  'The LOWEST-priority duration rung: a quote/job override wins, then LEARNED history '
  '(lib/dayFit resolveDuration), then this. It is a starting point an owner typed, never evidence.';

comment on column public."service_templates"."default_crew_size" is
  'Catalogue DEFAULT number of workers this service normally needs. NULL = not stated. '
  'A DEFAULT ONLY — distinct from the scheduled assignment on a job and from who actually '
  'worked it (job_work_sessions). Never reconciled against either.';
