-- ── Quote V2 · Phase 0 · The database stops inventing prices ─────────────────
-- Master plan: https://claude.ai/code/artifact/6082f1d8-33b9-4541-af8a-ef0041aacb66
--
-- THE HARM. `quotes.total` is a generated column:
--     COALESCE(initial_price, hours * crew_size * rate) + COALESCE(travel_fee, 0)
--                             ^^^^^^^^^^^^^^^^^^^^^^^^
-- When no price was entered, the DATABASE made one up from three columns whose
-- defaults are hours=1, crew_size=1, rate=50.00. QuoteBuilder was deliberately
-- rewritten to stop inventing exactly this number ("2hr × 1 crew × $50 = $100") —
-- and the generated column went on doing it one layer down, where no code review
-- would ever see it.
--
-- It reached real customers. Four rows priced this way; TWO are `completed`, i.e.
-- work was done and billed on a number no pricing engine ever produced:
--     EPS-2026-0046  lisa       2 × 1 × $60  = $120.00  completed
--     EPS-2026-0026  Danielle   0.25 × 1 × $65 = $16.25  completed
--     EPS-0002       Nicole     1 × 1 × $75  = $75.00   scheduled
--     EPS-2026-0030  (owner's own test)      = $100.00  accepted
--
-- ORDER MATTERS — this is why the backfill comes first:
--   1. Backfill `initial_price` for those 4 rows, from `hours * crew_size * rate`.
--      NOT from `total` — total already INCLUDES travel_fee, so copying it would
--      double-count travel the moment the new expression adds travel again.
--      After this, every row's total is unchanged (the COALESCE simply stops
--      needing its fallback).
--   2. THEN redefine the column. Because no row relies on the fallback any more,
--      removing it cannot move a single total.
--
-- Verified before: 55 rows, sum 5361.00, fingerprint 9d34185c6c0285047de7134eea1c8ab2
-- The same three must hold after. If they don't, this migration is wrong.
--
-- WHY NULL, NOT ZERO. An unpriced quote now has NO total, rather than a $0 one —
-- the same rule this codebase already applies elsewhere ("an unknown duration is
-- NULL, never 0; unknown hours is not 2 hours, the same way an unknown cost is not
-- $0"). NULL is also what makes the absence detectable at all: a fabricated $100 is
-- indistinguishable from a real $100, whereas a missing total is missing.
--
-- ⚠️ KNOWN GAP, deliberately left for Quote V2's UX work, NOT hidden:
--    formatCurrency(null) renders "$0.00" (verified, not assumed). So an unpriced
--    quote DISPLAYS as $0.00 rather than "no price yet". That is a display bug, and
--    it is strictly better than the one it replaces — $0.00 is visibly broken, where
--    a fabricated $100 is quietly wrong — but it is not the finished experience.
--    Today it is unreachable anyway: after the backfill no row has a null total, and
--    the send guard (this same phase) stops an unpriced quote reaching a customer.
--
-- The 3 triggers on `quotes` (updated_at, integration capture, accepted notify) read
-- `total` from plpgsql, which resolves column names at RUNTIME — a drop+add inside
-- one migration is transparent to them. No index, constraint or view depends on it.

-- 1. Give the four fabricated rows an explicit price equal to what they already read.
--    `hours`, `crew_size` and `rate` are NOT NULL, so this cannot produce a null.
update public.quotes
   set initial_price = round((hours * crew_size * rate)::numeric, 2)
 where initial_price is null;

-- 2. The column can no longer invent anything.
alter table public.quotes drop column total;
alter table public.quotes
  add column total numeric(10,2)
  generated always as (initial_price + coalesce(travel_fee, (0)::numeric)) stored;

comment on column public.quotes.total is
  'GENERATED = initial_price + travel_fee. NULL when the quote has no price — deliberately NOT 0, because an unpriced quote is not a free one. It must never fall back to hours*crew_size*rate again: that fabricated a price the pricing engine never produced, and two customers were billed on it (see RUN-2026-07-16e).';
