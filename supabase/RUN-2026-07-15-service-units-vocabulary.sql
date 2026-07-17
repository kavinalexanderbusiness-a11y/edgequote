-- ── Universal unit of work: the vocabulary ───────────────────────────────────
-- APPLIED to production 2026-07-15 via Supabase MCP (apply_migration) and read
-- back: 9 system units present, RLS on, 4 policies, and both pre-existing
-- quote_services lines resolve against a system unit. Committed here because the
-- repo remains the source of truth for migration history.
--
-- WHY
-- A quote line has ALWAYS been quantity x unit_price (lib/quoteServices
-- serviceLineTotals) with a free-text `unit` defaulting to 'each'. The maths was
-- never lawn-specific; the unit simply had no vocabulary. This adds one.
--
-- A unit is a LABEL + a formatting rule. It never enters the arithmetic — which
-- is exactly why nine units are safe to add: no total, anywhere, changes.
--
-- Rows, not an enum, so a custom unit costs an INSERT rather than a deploy.
--   user_id IS NULL  -> a system unit, readable by everyone
--   user_id = <uid>  -> that owner's custom unit
--
-- NOT TOUCHED: lib/pricing.ts. Lawn is base + (sqft/1000 x rate) with cadence
-- multipliers — it is NOT quantity x rate, is not expressible as a unit, and
-- never consults this table. servicePricingKind() keeps the two families apart.
--
-- SAFETY: additive. New table only; no column altered, nothing backfilled,
-- nothing dropped. Idempotent (create if not exists + on conflict do nothing).

create table if not exists public.service_units (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,   -- NULL = system
  code        text not null,
  label       text not null,          -- "Square feet"
  abbrev      text not null,          -- "sq ft"
  step        numeric not null default 1,   -- quantity input step
  decimals    int not null default 0,       -- decimals when showing a quantity
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Two PARTIAL unique indexes, not one composite. Postgres treats NULLs as
-- distinct in a unique index, so a plain unique(user_id, code) would happily
-- allow 'sqft' to be seeded as a system unit many times over.
create unique index if not exists service_units_system_code_key
  on public.service_units (code) where user_id is null;
create unique index if not exists service_units_user_code_key
  on public.service_units (user_id, code) where user_id is not null;

create index if not exists service_units_user_idx on public.service_units (user_id);

alter table public.service_units enable row level security;

-- System units are readable by everyone; an owner sees and edits only their own.
-- (select auth.uid()) — not bare auth.uid() — so the planner evaluates it once
-- per query instead of once per row.
drop policy if exists service_units_read on public.service_units;
create policy service_units_read on public.service_units for select
  using (user_id is null or user_id = (select auth.uid()));

drop policy if exists service_units_insert on public.service_units;
create policy service_units_insert on public.service_units for insert
  with check (user_id = (select auth.uid()));

drop policy if exists service_units_update on public.service_units;
create policy service_units_update on public.service_units for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists service_units_delete on public.service_units;
create policy service_units_delete on public.service_units for delete
  using (user_id = (select auth.uid()));

-- The nine system units. 'each' is FIRST and load-bearing: quote_services.unit
-- already defaults to the literal 'each', so every line written before today
-- resolves against this row instead of dangling. (Verified live: 2/2 existing
-- lines resolve.)
insert into public.service_units (user_id, code, label, abbrev, step, decimals, sort_order) values
  (null, 'each',      'Each',        'each',      1,    0, 10),
  (null, 'hour',      'Hours',       'hr',        0.25, 2, 20),
  (null, 'flat',      'Flat rate',   'flat',      1,    0, 30),
  (null, 'sqft',      'Square feet', 'sq ft',     1,    0, 40),
  (null, 'linear_ft', 'Linear feet', 'linear ft', 1,    0, 50),
  (null, 'fixture',   'Fixtures',    'fixture',   1,    0, 60),
  (null, 'room',      'Rooms',       'room',      1,    0, 70),
  (null, 'zone',      'Zones',       'zone',      1,    0, 80),
  (null, 'equipment', 'Equipment',   'unit',      1,    0, 90)
on conflict (code) where user_id is null do nothing;
