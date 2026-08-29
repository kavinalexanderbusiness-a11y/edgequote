-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSAL · Session 110 · ROUTE PINS  (v2 — tenant-welded)
--
-- ⛔ NOT APPLIED, and deliberately not named with a version. See the README in
-- this directory: nothing here is in the apply path. Session 110 is not the
-- lander and has touched no production schema.
--
-- ⭐ REVIEWED AGAINST origin/main `fc31857f` (baseline 20260826120001, the
-- post-convergence one). npm run verify:route-pins builds this on top of the
-- real apply path in PGlite and runs the attacks — a regex can be satisfied by
-- a comment; a refused INSERT cannot.
--
-- ══ THE TWO FACTS THIS MODEL KEEPS APART ═══════════════════════════════════
--
--   jobs.route_order   WHERE A STOP CURRENTLY IS.
--                      True of every stop on every day. Written by the day
--                      board's one writer, cleared by trg_jobs_clear_route_order
--                      whenever the visit changes day, and rewritten wholesale
--                      by every optimize run the owner accepts.
--
--   route_pins         THAT THE OWNER CHOSE IT AND WANTS IT HELD.
--                      An input to the next optimize run, not an output of the
--                      last one. Nothing writes it except the owner pinning.
--
-- ⛔ Collapsing them means every optimize silently pins the whole day, and the
-- owner can never again express "this one, and I am not negotiating". They are
-- therefore in different tables, written by different actions, with different
-- lifetimes — and this file adds NO route_order column to schedule_items,
-- because an estimate's position still cannot be persisted as a sequence.
--
-- ══ WHY BOTH KINDS, WITHOUT AN ESTIMATE BECOMING A JOB ═════════════════════
-- A pin has to work for a visit AND for an estimate appointment: you cannot
-- drive to a 10 AM estimate without it costing the visit on either side. A
-- `jobs.pinned_position` column would leave estimates exactly where they are,
-- which is the half that keeps the two lists separate.
--
-- ⭐ The boundary is preserved because the REFERENCE is, not because a rule
-- says so: an estimate is pointed at through schedule_item_id, a visit through
-- job_id, and nothing in this table can turn one into the other. Labour,
-- revenue, invoicing, recurrence and completion all read `jobs`; a row here
-- reaches none of them. Adding a pin gives an estimate a POSITION and nothing
-- else — no status, no money, no completion (Session 79's boundary, intact).
--
-- ══ TENANCY: COMPOSITE WELDS, NOT SINGLE-COLUMN FKs ════════════════════════
-- ⚠️⚠️ v1 of this proposal used `job_id uuid references jobs(id)`. That is the
-- B1/B2 defect shape exactly (verify:tenant-weld): RLS validates only
-- `auth.uid() = user_id`, so tenant A could insert a pin carrying its OWN
-- user_id and tenant B's job_id. Two things follow, and the second is the
-- serious one:
--   • the row cascades off B's job, so B's deletions silently touch A's rows;
--   • the FK becomes an EXISTENCE ORACLE — "accepted" vs "violates foreign key"
--     tells A whether a given uuid is a real job in some other tenant.
-- The composite weld makes the tenant part of the reference itself, so a pin
-- can only ever point at a stop its own tenant owns. Same shape as
-- custom_field_values_job_fkey, payments_invoice_tenant_fkey and the rest.
--
-- ⚠️ `jobs` already carries jobs_id_user_key UNIQUE (id, user_id).
-- `schedule_items` does NOT — this migration adds it, exactly as the payments
-- weld needed invoices_user_id_id_key added before it.
--
-- ══ WHAT IS DELIBERATELY *NOT* CONSTRAINED ═════════════════════════════════
-- ⛔ No uniqueness on (user_id, date, position). Two stops claiming one seat is
-- resolved deterministically and totally by lib/routePins `orderWithPins` (the
-- earlier pin keeps the seat, the later one takes the nearest free one). A
-- database unique would be the stricter-looking choice and the wrong one: the
-- browser client reorders row by row with no enclosing transaction, so a plain
-- unique makes an ordinary swap fail, and a DEFERRABLE one only helps inside a
-- transaction that client never opens. A constraint that forces the app to work
-- around it has not made anything safer.
-- ⛔ No ON UPDATE CASCADE anywhere: ids are immutable here.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path to public, extensions;

-- ── 0 · The weld target schedule_items is missing ───────────────────────────
-- A composite foreign key needs a matching unique key on the parent. `jobs` has
-- one; schedule_items has never been a weld target, so it has none.
alter table public."schedule_items"
  drop constraint if exists "schedule_items_id_user_key";
alter table public."schedule_items"
  add constraint "schedule_items_id_user_key" unique (id, user_id);

-- ── 1 · The table ───────────────────────────────────────────────────────────
create table if not exists public."route_pins" (
  "id" uuid default extensions.uuid_generate_v4() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "user_id" uuid not null,
  -- The day whose driving order this pin belongs to. NOT a cache of the stop's
  -- date: it is what makes a pin chosen for Tuesday provably meaningless on
  -- Thursday, and it is what the per-day read is indexed on.
  "date" date not null,
  -- 1-based seat in that day's order.
  "position" integer not null,
  -- Exactly one of these is set (route_pins_one_stop_check).
  "job_id" uuid,
  "schedule_item_id" uuid
);

alter table public."route_pins"
  add constraint "route_pins_pkey" primary key (id);

alter table public."route_pins"
  add constraint "route_pins_user_id_fkey"
  foreign key (user_id) references auth.users(id) on delete cascade;

-- ── 2 · The welds ───────────────────────────────────────────────────────────
-- ⭐ ON DELETE CASCADE is what makes "the pinned stop was deleted" stop being an
-- application problem: no sweeper to write, no orphan to leak.
alter table public."route_pins"
  add constraint "route_pins_job_tenant_fkey"
  foreign key (job_id, user_id) references public.jobs(id, user_id) on delete cascade;

alter table public."route_pins"
  add constraint "route_pins_item_tenant_fkey"
  foreign key (schedule_item_id, user_id) references public.schedule_items(id, user_id) on delete cascade;

-- ── 3 · Shape ───────────────────────────────────────────────────────────────
-- A pin points at exactly one stop. Not zero (a pin on nothing holds no seat)
-- and not two (a row that is both a visit and an estimate is the exact
-- confusion this whole model exists to prevent).
alter table public."route_pins"
  add constraint "route_pins_one_stop_check"
  check (
    (job_id is not null and schedule_item_id is null)
    or (job_id is null and schedule_item_id is not null)
  );

alter table public."route_pins"
  add constraint "route_pins_position_check" check ("position" >= 1);

-- One pin per stop. Partial, because only one of the two columns is ever set.
create unique index if not exists route_pins_job_unique
  on public.route_pins (user_id, job_id) where job_id is not null;
create unique index if not exists route_pins_item_unique
  on public.route_pins (user_id, schedule_item_id) where schedule_item_id is not null;

-- The read the day board makes: this owner's pins for this day.
create index if not exists route_pins_user_date_idx
  on public.route_pins (user_id, date);

-- ── 4 · The stop a pin points at must be routable, and on that day ──────────
-- ⭐ Two invariants no CHECK can express, because both look at another table.
--
--   • ROUTABLE KIND. schedule_items carries five types and only 'estimate' is
--     routable (Session 79). A pin on a reminder is a seat held for something
--     nobody drives to.
--   • THE PIN'S DAY IS THE STOP'S DAY. Without this, `date` is a claim rather
--     than a fact, and every reader has to re-derive it.
--
-- SECURITY INVOKER on purpose: the owner is reading their own stop, RLS permits
-- exactly that, and this product does not need another SECURITY DEFINER
-- function to look up a row by its own primary key.
create or replace function public.route_pins_guard() returns trigger
language plpgsql as $$
declare v_date date; v_type text;
begin
  -- ⚠️ A BEFORE ROW trigger runs ahead of the CHECK constraints, so a row that
  -- points at NOTHING would reach the estimate lookup below and be refused with
  -- a message about routable kinds. Stand aside and let
  -- route_pins_one_stop_check say the true thing.
  if new.job_id is null and new.schedule_item_id is null then
    return new;
  end if;
  if new.job_id is not null then
    select scheduled_date into v_date from public.jobs where id = new.job_id;
    if v_date is null then
      raise exception 'route_pins: job % has no scheduled date', new.job_id;
    end if;
  else
    select scheduled_date, type into v_date, v_type
      from public.schedule_items where id = new.schedule_item_id;
    if v_type is distinct from 'estimate' then
      raise exception 'route_pins: only an estimate appointment is routable, not %', coalesce(v_type, '(missing)');
    end if;
  end if;
  if new.date is distinct from v_date then
    raise exception 'route_pins: pin date % is not the stop''s day %', new.date, v_date;
  end if;
  return new;
end $$;

drop trigger if exists "trg_route_pins_guard" on public."route_pins";
create trigger trg_route_pins_guard
  before insert or update on public.route_pins
  for each row execute function route_pins_guard();

-- ── 5 · When the work moves day, the pin does not follow it ─────────────────
-- ⭐ This is the PIN half of a rule the schema already states for the other
-- fact: trg_jobs_clear_route_order nulls route_order when a visit changes day,
-- because a position chosen for Tuesday means nothing on Thursday. A pin is the
-- same question about the same event, so it gets the same answer rather than a
-- new policy — and it is answered in the DATABASE so a second device sees the
-- cleanup too, instead of each client deciding for itself.
create or replace function public.route_pins_drop_on_move() returns trigger
language plpgsql as $$
begin
  if new.scheduled_date is distinct from old.scheduled_date then
    if tg_table_name = 'jobs' then
      delete from public.route_pins where job_id = new.id;
    else
      delete from public.route_pins where schedule_item_id = new.id;
    end if;
  end if;
  return null;
end $$;

drop trigger if exists "trg_jobs_drop_route_pins" on public."jobs";
create trigger trg_jobs_drop_route_pins
  after update of scheduled_date on public.jobs
  for each row execute function route_pins_drop_on_move();

drop trigger if exists "trg_schedule_items_drop_route_pins" on public."schedule_items";
create trigger trg_schedule_items_drop_route_pins
  after update of scheduled_date on public.schedule_items
  for each row execute function route_pins_drop_on_move();

drop trigger if exists "trg_route_pins_updated" on public."route_pins";
create trigger trg_route_pins_updated
  before update on public.route_pins
  for each row execute function set_updated_at();

-- ── 6 · Tenancy at the row level ────────────────────────────────────────────
-- The same four policies every owner-scoped table here carries. RLS is what
-- separates one `authenticated` session from another; the welds above are what
-- stop a session with a valid user_id from pointing at somebody else's stop.
-- Both are needed — neither substitutes for the other.
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

-- ── 7 · Grants ──────────────────────────────────────────────────────────────
-- ⚠️⚠️ This database carries `alter default privileges ... grant ALL on tables
-- to anon`, so a NEW table arrives already granted to anon. RLS would still
-- refuse the rows, but a DML grant to nobody is not something to leave lying
-- around. PUBLIC is revoked SEPARATELY: revoking anon does not remove a grant
-- made to PUBLIC (tenant-boundary audit, 2026-08-10).
--
-- ⭐⭐ `authenticated` is revoked FIRST and then re-granted only DML — which is
-- stricter than most tables in this schema currently are, deliberately. The
-- default-privileges grant is ALL, and ALL includes **TRUNCATE, which bypasses
-- row level security entirely**: one signed-in tenant could empty every
-- tenant's pins, and no policy would be consulted. RLS protects rows; it does
-- not protect the table. Granting the four verbs the app actually uses costs
-- nothing and closes that.
-- ⚠️ OBSERVATION FOR S106, not a change made here: the same default-privileges
-- grant means `authenticated` holds ALL — TRUNCATE included — on the existing
-- owner-scoped tables too. That is a pre-existing, app-wide condition well
-- outside this lane; it is recorded because this guard is what surfaced it.
revoke all on table public."route_pins" from public;
revoke all on table public."route_pins" from anon;
revoke all on table public."route_pins" from authenticated;
grant select, insert, update, delete on table public."route_pins" to authenticated;
grant all on table public."route_pins" to service_role;

revoke all on function public."route_pins_guard"() from public, anon, authenticated, service_role;
grant execute on function public."route_pins_guard"() to service_role;
revoke all on function public."route_pins_drop_on_move"() from public, anon, authenticated, service_role;
grant execute on function public."route_pins_drop_on_move"() to service_role;

comment on table public.route_pins is
  'Session 110. An owner-declared position hold in one day''s driving order: "keep this stop in this position while optimizing the rest". NOT an appointment time, NOT a customer promise, NOT jobs.route_order (which records where a stop IS, for every stop, and is rewritten by every optimize run), and NOT an assignment. Covers both routable kinds — a visit (job_id) and an estimate appointment (schedule_item_id) — without making an estimate a job: a pin grants a POSITION and nothing else. Tenant-welded to both parents, so a pin can only point at a stop its own tenant owns.';
