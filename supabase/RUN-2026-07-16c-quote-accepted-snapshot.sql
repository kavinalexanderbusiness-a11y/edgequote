-- ── Pricing v2 · Phase 0 · Sensor: record what was actually BOUGHT ───────────
-- Master plan: https://claude.ai/code/artifact/6082f1d8-33b9-4541-af8a-ef0041aacb66
--
-- THE PROBLEM. Nothing records what a customer agreed to. `repPriceAndCadence`
-- GUESSES, weekly-first, off whatever cadence columns happen to be populated. Live
-- consequence: a **paid $489.25 Grass Seeding job** carrying a leftover
-- `weekly_price` of 56.65 is learned as **"$56.65 weekly"** — and then judged against
-- a mowing anchor. The learner is being trained on fiction.
--
-- WHY THIS IS PHASE 0 AND NOT PHASE 5. It collects nothing retroactively. Every day
-- without these columns is a day of acceptances that can never be learned from. The
-- roadmap's sequencing law: fix the sensors before the brain. Most of the learning
-- work in Phase 5 is downstream of this one migration.
--
-- DELIBERATELY NOT BACKFILLED. The only available source for a historic value is
-- `repPriceAndCadence`'s guess — the exact thing these columns exist to replace.
-- Backfilling would launder the guess into the record and make it unfalsifiable.
-- NULL means "nobody told us", which is true, and which Phase 5 can honestly skip.
--
-- NOT a pricing-engine change: nothing reads these yet. This is a tape recorder.

alter table public.quotes
  add column if not exists accepted_price numeric(10,2),
  add column if not exists selected_cadence text;

-- The vocabulary is the one the pricing engine already speaks (PricingPackage's
-- cadence). A DB constraint rather than app validation, per the standing principle:
-- there is no write path that can invent a fifth cadence.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_selected_cadence_check'
  ) then
    alter table public.quotes
      add constraint quotes_selected_cadence_check
      check (selected_cadence is null or selected_cadence in ('one_time','weekly','biweekly','monthly'));
  end if;
end $$;

comment on column public.quotes.accepted_price is
  'SNAPSHOT of what the customer agreed to pay, captured at acceptance. Deliberately a copy, not a reference to total: editing a quote afterwards must never rewrite what was agreed. NULL = accepted before this column existed, or accepted by a path that does not know. Never guess it.';

comment on column public.quotes.selected_cadence is
  'Which cadence was actually bought (one_time|weekly|biweekly|monthly). NULL = nobody said — do NOT infer it from whichever price column is populated; that is the bug this column exists to kill.';

-- The learner will ask "what did we sell, and for how much" — an index on the won
-- set keeps that cheap as the book grows.
create index if not exists quotes_accepted_snapshot_idx
  on public.quotes (user_id, selected_cadence)
  where accepted_price is not null;
