-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-15b — Equipment warranty + depreciation
--
-- Two money questions the fleet page couldn't answer:
--   "Is this repair covered?"  — a crew pays a shop for work still under
--                                warranty because nobody remembered the date.
--   "What's it actually worth?" — purchase price is what you PAID; the
--                                accountant (and a resale) want book value.
--
-- Additive columns only — no table changes, no backfill. Every field is
-- optional: a machine without a warranty date or a useful life simply reports
-- "no warranty on file" / falls back to purchase price, exactly as today.
--
-- Idempotent — safe to run more than once. Requires RUN-2026-07-15-equipment.sql.
-- ════════════════════════════════════════════════════════════

-- Warranty: when cover ends, and who honours it.
alter table public.equipment add column if not exists warranty_expires  date;
alter table public.equipment add column if not exists warranty_provider text;

-- Straight-line depreciation inputs. useful_life_years null = not depreciated
-- (book value stays at purchase price). salvage_value = residual at end of life.
alter table public.equipment add column if not exists useful_life_years integer;
alter table public.equipment add column if not exists salvage_value     numeric;
