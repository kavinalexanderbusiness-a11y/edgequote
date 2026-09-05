-- ═══════════════════════════════════════════════════════════════════════════
-- Session 79 · ESTIMATE APPOINTMENTS
--
-- THE WORKAROUND THIS REPLACES. To hold a slot for "drive out, look at it, then
-- price it", the owner had to create a $0 quote and a $0 job and put the JOB on
-- the calendar. Everything in this system that is shaped like work then fired
-- against something that was never work: job completion, the customer
-- "your service is complete" message, proof-of-work, invoicing, revenue,
-- recurrence satisfaction and review-request eligibility. The owner was paying
-- for the calendar slot with false records.
--
-- THE PRIMITIVE ALREADY EXISTED. public.schedule_items is the NON-JOB calendar
-- table (src/lib/scheduleItems.ts). Its 'estimate' type is already the only
-- `routable: true` one, and it already carries converted_quote_id — it was
-- built for exactly this and then stranded: the Calendar accepted a
-- `scheduleItems` prop the schedule page never passed, so the table had writers
-- and NO READERS. Rather than leave a lie on screen, earlier sessions removed
-- the writers (see the REMOVED notes in messages/page.tsx and
-- ConversationInfo.tsx) and the table went empty. It is still the right shape
-- and still the smallest concept that fits, so this migration finishes it for
-- estimates instead of inventing a second calendar.
--
-- ⭐ THE BOUNDARY IS THE TABLE, NOT A RULE. Labour, revenue, invoicing,
-- recurrence, work sessions, proof-of-work and review eligibility every one of
-- them read `jobs`. An estimate appointment is not a row in `jobs`, so
-- completing one cannot reach any of them. That is structural. No trigger on
-- this table writes to another, and this migration adds none — the guard
-- (npm run verify:estimate-appointments) asserts that emptiness directly.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path to public, extensions;

-- ── 1 · Lifecycle and vocabulary, enforced by the database ──────────────────
-- The TypeScript union has always said five types and three statuses; nothing
-- made the database agree, so a typo or a future writer could invent a sixth
-- type that every reader would then have to guess about. The table is empty
-- (see the comment on public.follow_ups, which cites it as such), so these can
-- be plain CHECKs rather than NOT VALID — if production disagrees, this fails
-- loudly on apply, which is the outcome we want.
--
-- `no_show` is new. It is a real and different outcome from `cancelled`: the
-- owner drove there and lost the trip. Collapsing the two would erase the only
-- signal that distinguishes an unreliable customer from a considerate one.
alter table public."schedule_items"
  drop constraint if exists "schedule_items_type_check";
alter table public."schedule_items"
  add constraint "schedule_items_type_check"
  check (type in ('estimate', 'callback', 'appointment', 'task', 'reminder'));

alter table public."schedule_items"
  drop constraint if exists "schedule_items_status_check";
alter table public."schedule_items"
  add constraint "schedule_items_status_check"
  check (status in ('scheduled', 'completed', 'cancelled', 'no_show'));

-- ── 2 · Who is going ────────────────────────────────────────────────────────
-- Mirrors `jobs` exactly (jobs.crew_id + jobs.technician_id) so "who is going"
-- is one idea with one shape across the calendar. Deliberately NOT a new
-- assignment model: a crew XOR a person, per the canonical rule, enforced below
-- rather than left to the form.
alter table public."schedule_items" add column if not exists "crew_id" uuid;
alter table public."schedule_items" add column if not exists "technician_id" uuid;

alter table public."schedule_items"
  drop constraint if exists "schedule_items_crew_id_fkey";
alter table public."schedule_items"
  add constraint "schedule_items_crew_id_fkey"
  foreign key (crew_id) references public.crews(id) on delete set null;

alter table public."schedule_items"
  drop constraint if exists "schedule_items_technician_id_fkey";
alter table public."schedule_items"
  add constraint "schedule_items_technician_id_fkey"
  foreign key (technician_id) references public.technicians(id) on delete set null;

-- An appointment is assigned to a crew, or to a person, or to nobody (the solo
-- owner's normal case) — never to both. Two answers to "who is going" is how a
-- day board and a route come to disagree about the same 10:30.
alter table public."schedule_items"
  drop constraint if exists "schedule_items_one_assignee_check";
alter table public."schedule_items"
  add constraint "schedule_items_one_assignee_check"
  check (crew_id is null or technician_id is null);

-- ── 3 · Two audiences, two columns ──────────────────────────────────────────
-- `notes` is and stays INTERNAL — the same rule proof-of-work had to learn the
-- hard way when jobs.notes turned out to be rendered to customers. Anything the
-- customer may see lives in its own column, so the audience is the COLUMN and
-- never a visibility flag someone has to remember to set.
alter table public."schedule_items" add column if not exists "customer_note" text;

-- Why it did not happen. Applies to cancelled and no_show alike; null otherwise.
alter table public."schedule_items" add column if not exists "cancel_reason" text;

-- ── 4 · updated_at ──────────────────────────────────────────────────────────
-- The table had created_at and completed_at but no updated_at, so a reschedule
-- left no trace of WHEN it was rescheduled. Uses the existing shared function —
-- one engine for "stamp the row", not a third copy of it.
alter table public."schedule_items"
  add column if not exists "updated_at" timestamp with time zone default now() not null;

drop trigger if exists trg_schedule_items_updated on public."schedule_items";
create trigger trg_schedule_items_updated
  before update on public."schedule_items"
  for each row execute function public.set_updated_at();

-- ── 5 · Tenant weld on UPDATE ───────────────────────────────────────────────
-- The update policy had USING but no WITH CHECK. USING decides which rows you
-- may touch; without WITH CHECK nothing validates the row you leave behind, so
-- a tenant could update their own appointment and set user_id to somebody
-- else's — handing a row across the boundary. Same shape as the welds Session
-- 75 added elsewhere.
drop policy if exists "schedule_items: update own" on public."schedule_items";
create policy "schedule_items: update own" on public."schedule_items"
  as permissive for update to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- ── 6 · anon has no business here ───────────────────────────────────────────
-- `grant ALL ... to anon` is what Supabase writes at CREATE TIME; it is not a
-- decision anybody made. RLS already stops an anonymous caller (auth.uid() is
-- null, so `null = user_id` is never true), but no anonymous door reads or
-- writes this table and the grant should not outlive that fact. Revoking the
-- role's grant is not the same as removing the PUBLIC grant, so both go.
revoke all on table public."schedule_items" from anon;
revoke all on table public."schedule_items" from public;

-- ── 7 · The calendar's read ─────────────────────────────────────────────────
-- The month/week/day views ask for one tenant's items across a date RANGE, and
-- the estimate surfaces ask only for estimates. schedule_items_user_date_idx
-- (user_id, scheduled_date) already serves the range; this partial index keeps
-- the estimate-only reads off the callbacks and tasks that share the table.
create index if not exists schedule_items_estimates_idx
  on public.schedule_items (user_id, scheduled_date)
  where type = 'estimate';

comment on table public."schedule_items" is
  'Non-job calendar entries: estimate / callback / appointment / task / reminder. A row here is NEVER work — labour, revenue, invoicing, recurrence, work sessions, proof-of-work and review eligibility all read public.jobs, so completing an estimate appointment cannot reach any of them. type=''estimate'' is the scheduled visit that produces a quote (Session 79); converted_quote_id is the quote it is about, whether that quote existed first or was written afterwards.';

comment on column public."schedule_items"."notes" is
  'INTERNAL only — never rendered to a customer. Customer-facing wording lives in customer_note.';

comment on column public."schedule_items"."customer_note" is
  'Optional customer-facing note for the appointment. The audience is the COLUMN, never a visibility flag.';

comment on column public."schedule_items"."converted_quote_id" is
  'The quote this visit is about. Set when the owner writes the quote from the visit, or when an existing draft quote is given an appointment. One link, both directions.';
