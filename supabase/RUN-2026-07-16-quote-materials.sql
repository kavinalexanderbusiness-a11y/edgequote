-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-16b — Materials as first-class quote items (Quote V2 prep)
--
-- APPLIED + VERIFIED in production 2026-07-16 via Supabase MCP (migration
-- `quote_materials`). Requires RUN-2026-07-15-service-units-vocabulary.sql.
--
-- SCOPE, STATED AS WHAT IT IS NOT.
-- This is the CUSTOMER-FACING half of materials and nothing else:
--   NO inventory reservation. NO allocation. NO stock deduction.
--   NO costing. NO margin. NO link to parts / part_movements.
-- A material line here is an ESTIMATE ON A DOCUMENT — the same species as a
-- service line: quantity × unit_price, discounted by the one discount engine.
-- It never touches the movement ledger, and the ledger's invariant
-- (qty_on_hand = sum(part_movements.qty)) is not in scope here at all.
--
-- ⚠️ WHY THERE IS NO quote_materials TABLE.
-- A second line table would mean a second price rollup: quotes.initial_price is
-- Σ line nets over quote_services, and the generated quotes.total is built from
-- it. Two line tables = two sums = drift, in the money column. A material is not
-- a different KIND OF ROW, it is a different KIND OF LINE — so it is one column
-- on the table that already exists, and every total keeps working untouched.
--
-- ⚠️ COST IS DELIBERATELY ABSENT.
-- What a material COSTS the business is the Pricing V2 Phase 1 / Inventory D1
-- question (one canonical cost model, platform-wide). Adding a cost column here
-- would pre-empt that decision and create the second cost model the whole V2
-- effort exists to prevent. This migration adds REVENUE vocabulary only.
--
-- Idempotent — safe to run more than once.
-- ════════════════════════════════════════════════════════════

-- ── 1. Line kind ─────────────────────────────────────────────────────────────
-- 'service' (default) preserves every existing row's meaning byte-for-byte.
alter table public.quote_services
  add column if not exists kind text not null default 'service';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_services'::regclass and conname = 'quote_services_kind_check'
  ) then
    alter table public.quote_services
      add constraint quote_services_kind_check check (kind in ('service','material'));
  end if;
end $$;

comment on column public.quote_services.kind is
  'What this line IS: service (labour you perform) or material (goods you supply). A material line is an ESTIMATE ON THE QUOTE — quantity x unit_price, same arithmetic, same discount engine. It never reserves, allocates or deducts stock, and carries no cost: see RUN-2026-07-16-quote-materials.sql.';

-- service_type holds the line's NAME ("Mulch"), which is what it has always held
-- for services too. The column name is historical, not a claim about content —
-- the same convention properties.lawn_sqft follows ("measured area, whatever was
-- measured"). Renaming it would touch every quote read in the app to buy nothing.
comment on column public.quote_services.service_type is
  'The line''s display name. For kind=service, the service performed; for kind=material, the material supplied ("Mulch"). Historical name — not a claim that the line is a service.';

-- ── 2. Five system units ─────────────────────────────────────────────────────
-- Bulk landscape materials had no vocabulary: you cannot quote mulch without a
-- cubic yard. These are SYSTEM rows (user_id is null) and join the existing nine
-- as peers — they are NOT a materials-only list. A second unit vocabulary is
-- exactly the failure lib/units.ts documents (a four-value list once shadowed the
-- nine and silently dropped 'fixture' from a plumber's quote).
--
-- THE RULE THEY INHERIT: a unit is a LABEL and a formatting rule. It NEVER enters
-- the arithmetic. That is why adding five is safe — no total anywhere changes,
-- because nothing here is consulted while computing one.
--
-- Deliberately NOT added: a 'flat' for a tray of annuals — 'flat' already means
-- FLAT RATE in this vocabulary, and one code meaning two things in a money
-- picker is how a quote becomes wrong quietly. Plants are 'each' or 'tray'.
insert into public.service_units (user_id, code, label, abbrev, step, decimals, sort_order) values
  (null, 'cubic_yard', 'Cubic yards', 'yd³',    0.5, 1, 100),  -- mulch, topsoil, aggregate
  (null, 'ton',        'Tons',        'ton',    0.5, 2, 110),  -- gravel, rock, sand
  (null, 'bag',        'Bags',        'bag',    1,   0, 120),  -- fertilizer, amendments
  (null, 'pallet',     'Pallets',     'pallet', 1,   0, 130),  -- sod, stone
  (null, 'tray',       'Trays',       'tray',   1,   0, 140)   -- annuals, plugs
on conflict do nothing;
