-- ── A per-unit rate needs sub-cent precision ─────────────────────────────────
-- Session 107, correcting Session 107.
--
-- ⚠️ THE BUG, MEASURED ON PRODUCTION. 20260823120000 declared
--     "rate" numeric(10,2)
-- which is right for a flat plan ($240/month) and WRONG for a per-unit one. A
-- $/sq ft rate is routinely finer than a cent: inserting $0.035/sq ft stored
-- 0.04, and against a 1,392 ft² measurement that is $49 quoted as $56 — a 14%
-- overcharge produced silently, by the column type, with nothing on screen to
-- suggest the owner's number had been changed underneath them.
--
-- Caught by driving the real modal against a real Price Book row and finding the
-- expected price absent; the rounding was invisible everywhere else, because
-- every layer above faithfully multiplied the number the database returned.
--
-- numeric(12,4) keeps four decimals — $0.0035/unit granularity, which covers
-- area, linear and count pricing with room to spare — while flat plans are
-- unaffected (240.00 and 240.0000 are the same number).
--
-- ⛔ WIDENING ONLY. numeric(10,2) → numeric(12,4) cannot lose data: every value
-- expressible in the old type is expressible in the new one, so this is safe to
-- run against a table that already holds rows. It does NOT recover the precision
-- of a rate that was already rounded on insert — those rows were rounded before
-- they landed, and no migration can know what the owner originally typed. There
-- are no such rows in production: the only ones that ever existed belonged to the
-- acceptance fixture and were removed with it.

alter table public."service_pricing_plans"
  alter column "rate" type numeric(12,4);

comment on column public."service_pricing_plans"."rate" is
  'Money per unit when basis = per_unit ($/sq ft, $/linear ft, $/item), or the whole price when basis = flat. numeric(12,4): a per-unit rate is regularly finer than a cent, and numeric(10,2) silently rounded $0.035/sq ft to $0.04 — a 14% overcharge on a 1,392 ft2 measurement.';
