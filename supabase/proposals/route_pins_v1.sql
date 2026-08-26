-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSAL · Session 110 · ROUTE PINS
--
-- ⛔ NOT APPLIED, and deliberately not named with a version. See the README in
-- this directory: nothing here is in the apply path. Session 110 was not the
-- lander and did not touch production schema.
--
-- ── WHAT IS MISSING ────────────────────────────────────────────────────────
-- The owner can now say "keep this stop here while you re-order the rest".
-- Everything about that works EXCEPT outliving the screen, because there is
-- nowhere to put the fact. The search is measured, not assumed:
--
--   jobs.route_order      — where a stop IS. True of every stop on every day,
--                           and rewritten by every optimize run. It cannot
--                           also mean "the owner CHOSE this seat": if it did,
--                           every optimize would silently pin the whole day.
--   schedule_items        — no route_order at all, so an estimate has neither
--                           half of the idea.
--   day_statuses          — whether a DAY is blocked/custom. No per-stop concept.
--   dispatch_notes        — one free-text `body` per day+crew. Encoding pins
--                           into prose is hiding structured state in a note.
--   schedule_health_ignored, suggestion_dismissals
--                         — generic DISMISSALS keyed by text. A pin is not a
--                           dismissal, and stuffing "pin:<date>:<uuid>:3" into
--                           an issue_key is the same hiding trick.
--   custom_field_values   — the OWNER's own fields, shown in the UI and
--                           exported. Engine state does not belong in a
--                           customer-visible field set.
--
-- ⛔ localStorage was rejected outright: a planning constraint that exists on
-- one browser and not on the owner's phone is a constraint that lies.
--
-- ── WHY A TABLE AND NOT A COLUMN ───────────────────────────────────────────
-- ⭐ A pin has to work for BOTH kinds of routable stop. A `jobs.pinned_position`
-- column would leave estimate appointments exactly where they are today —
-- driven to, timed, and unable to hold a position — which is half a feature and
-- the half that keeps the two lists separate. One table covers both and
-- requires no change to either existing table.
--
-- It follows public.custom_field_values, which is this schema's established
-- shape for "belongs to exactly one of several parents": two nullable FKs and a
-- CHECK, rather than a polymorphic (kind, id) pair that no foreign key can
-- protect. That buys real ON DELETE CASCADE — deleting a visit removes its pin,
-- with no sweeper to write and no orphan to leak.
--
-- ── WHY `date` IS HERE, THOUGH IT LOOKS DENORMALISED ───────────────────────
-- ⭐ It is a STALENESS DETECTOR, not a cache. A pin is a position within ONE
-- day's driving order. If the visit is moved to Thursday, the position the
-- owner chose on Tuesday is meaningless there — so the row records the day the
-- owner was planning, and a pin whose `date` no longer matches its stop's
-- `scheduled_date` is provably stale and gets dropped. Without it, a pin
-- follows its visit to a day nobody pinned it on and arrives holding a seat
-- someone chose for a different route.
--
-- ⛔ NOT industry-specific. Nothing here knows what the work is, what it is
-- called or what it is worth — a position constraint over routable stops, and
-- nothing else.
--
-- ── ADOPTING THIS ──────────────────────────────────────────────────────────
-- 1. Copy to supabase/migrations/<14-digit>_route_pins_v1.sql, taking the
--    version AT APPLY TIME from the live ledger so it sorts after everything
--    production has run.
-- 2. lib/routePins already models exactly this shape (RoutePin = stopId, kind,
--    position). The day board holds pins in component state; swapping that for
--    a load/save against this table is the only application change, and
--    `pinsPersist` in DayRoutePanel becomes true — the panel already says the
--    honest thing while it is false.
-- 3. `npm run verify:pinned-route` covers the rules; add a live half for RLS.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path to public, extensions;

create table if not exists public."route_pins" (
  "id" uuid default extensions.uuid_generate_v4() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "user_id" uuid not null,
  -- The day whose order this pin belongs to. See "staleness detector" above.
  "date" date not null,
  -- 1-based seat in that day's driving order.
  "position" integer not null,
  -- Exactly one of these is set (enforced below).
  "job_id" uuid,
  "schedule_item_id" uuid
);

alter table public."route_pins"
  add constraint "route_pins_pkey" primary key (id);

alter table public."route_pins"
  add constraint "route_pins_user_id_fkey"
  foreign key (user_id) references auth.users(id) on delete cascade;

-- ⭐ Real foreign keys, which is the whole reason for two columns instead of a
-- (kind, id) pair: when the stop goes, the pin goes with it. No sweeper, no
-- orphan, and "the pinned stop was cancelled" stops being an application
-- problem.
alter table public."route_pins"
  add constraint "route_pins_job_id_fkey"
  foreign key (job_id) references public.jobs(id) on delete cascade;

alter table public."route_pins"
  add constraint "route_pins_schedule_item_id_fkey"
  foreign key (schedule_item_id) references public.schedule_items(id) on delete cascade;

alter table public."route_pins"
  add constraint "route_pins_one_stop_check"
  check (
    (job_id is not null and schedule_item_id is null)
    or (job_id is null and schedule_item_id is not null)
  );

alter table public."route_pins"
  add constraint "route_pins_position_check" check (position >= 1);

-- One pin per stop. Partial uniques because only one of the two columns is set.
create unique index if not exists route_pins_job_unique
  on public.route_pins (user_id, job_id) where job_id is not null;
create unique index if not exists route_pins_item_unique
  on public.route_pins (user_id, schedule_item_id) where schedule_item_id is not null;

-- The read the day board makes: this owner's pins for this day.
create index if not exists route_pins_user_date_idx
  on public.route_pins (user_id, date);

drop trigger if exists "trg_route_pins_updated" on public."route_pins";
create trigger trg_route_pins_updated
  before update on public.route_pins
  for each row execute function set_updated_at();

-- ── Tenancy ────────────────────────────────────────────────────────────────
-- A pin is planning state and belongs to exactly one business. Same four
-- policies every owner-scoped table in this schema carries; nothing here is
-- reachable by anon, and nothing grants a crew session access — the field app
-- reads a day's ORDER (jobs.route_order), never the constraints behind it.
alter table public."route_pins" enable row level security;

drop policy if exists "route_pins: select own" on public."route_pins";
create policy "route_pins: select own" on public."route_pins"
  as permissive for select to public using (auth.uid() = user_id);

drop policy if exists "route_pins: insert own" on public."route_pins";
create policy "route_pins: insert own" on public."route_pins"
  as permissive for insert to public with check (auth.uid() = user_id);

drop policy if exists "route_pins: update own" on public."route_pins";
create policy "route_pins: update own" on public."route_pins"
  as permissive for update to public using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "route_pins: delete own" on public."route_pins";
create policy "route_pins: delete own" on public."route_pins"
  as permissive for delete to public using (auth.uid() = user_id);

comment on table public.route_pins is
  'Session 110. An owner-declared position hold in one day''s driving order: "keep this stop in this position while optimizing the rest". NOT an appointment time, NOT a customer promise, NOT jobs.route_order (which records where a stop IS, for every stop), and NOT an assignment. Covers both routable kinds — a visit (job_id) and an estimate appointment (schedule_item_id). `date` is a staleness detector: a pin whose date no longer matches its stop''s scheduled_date was chosen for a different day''s route and is dropped.';
