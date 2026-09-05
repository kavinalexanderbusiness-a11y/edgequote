-- ── Job association is a TENANT boundary, not just a pointer ────────────────
-- Run once, in the Supabase SQL editor. Idempotent.
--
-- ══ THE HOLE THIS CLOSES ═════════════════════════════════════════════════════
-- Three tables point at a job: expenses.job_id (what a visit cost),
-- time_entries.job_id (who worked it) and job_line_items.job_id (priced extras).
-- All three carried a SINGLE-COLUMN foreign key:
--
--     FOREIGN KEY (job_id) REFERENCES jobs(id)
--
-- and all three are protected by RLS policies that check ONLY `user_id`:
--
--     using (auth.uid() = user_id)   with check (auth.uid() = user_id)
--
-- Neither half checks that the JOB belongs to the same tenant. RLS proves who
-- owns the EXPENSE; the foreign key proves the job EXISTS. Nothing proved they
-- were the same business. So a signed-in Business A could POST an expense with
-- its own user_id and any job UUID at all — including one of Business B's — and
-- every layer said yes. Probed against production before this migration was
-- written: the insert was ACCEPTED (then rolled back).
--
-- Business B never SEES that row (its own RLS select filters by user_id), so
-- this is not a read leak. It is worse in a quieter way: the cost lands on a job
-- A cannot see, so lib/accounting/jobCosting groups it under a job that is absent
-- from A's own job list, while `untaggedCost` skips it too (it HAS a job_id).
-- The money vanishes from job costing entirely and still sits in the P&L. A
-- figure that disagrees with itself, caused by a pointer nobody validated.
--
-- ══ THE FIX, AND WHY IT IS THIS SHAPE ════════════════════════════════════════
-- Make the tenant part of the reference. `(job_id, user_id)` must name a row of
-- `jobs` that has BOTH — so a job belonging to another user_id is not a
-- permission failure to be checked in application code, it is a row that does
-- not exist. This is the pattern already used by
-- `time_entries_technician_same_owner`, which has protected the technician
-- pointer since the time clock shipped; the job pointer simply never got it.
--
-- A trigger or an RLS `with check (exists (select ...))` would also work and
-- both are weaker: a trigger can be disabled and an RLS subquery only guards the
-- doors that RLS covers, leaving DEFINER functions and service-role writes free.
-- A foreign key is checked by the storage engine for EVERY writer, including
-- service-role, `security definer` RPCs and psql. Nothing in this codebase can
-- route around it.
--
-- ON DELETE semantics are preserved exactly as they were, per table — this
-- migration changes WHO may be pointed at, never what happens when a job dies.
-- `set null (job_id)` names the column explicitly because `user_id` is NOT NULL
-- and must survive: an expense whose job is deleted becomes untagged spend, and
-- stays the owner's. (Postgres 15+ syntax; production is 17.6.)
--
-- SAFETY: `expenses`, `time_entries` and `job_line_items` all hold 0 rows in
-- production today, so no existing row can violate the new constraints. The
-- `not valid` / `validate` split is used anyway so this stays safe to run on a
-- database that has since accumulated rows: it takes no long lock, and if any
-- row DOES straddle tenants the VALIDATE step fails loudly instead of silently
-- rewriting the pointer.

begin;

-- ── 1. The referenced key ────────────────────────────────────────────────────
-- A composite foreign key needs a unique constraint on exactly its target
-- columns. `id` is already unique (primary key), so `(id, user_id)` is unique
-- for free — this adds no new restriction on `jobs`, it only makes the pair
-- referenceable.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.jobs'::regclass and conname = 'jobs_id_user_key'
  ) then
    alter table public.jobs add constraint jobs_id_user_key unique (id, user_id);
  end if;
end $$;

-- ── 2. expenses — what a visit cost ──────────────────────────────────────────
alter table public.expenses drop constraint if exists expenses_job_id_fkey;
alter table public.expenses drop constraint if exists expenses_job_same_owner;
alter table public.expenses
  add constraint expenses_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete set null (job_id)
  not valid;
alter table public.expenses validate constraint expenses_job_same_owner;

-- ── 3. time_entries — who worked it ──────────────────────────────────────────
-- The technician pointer already had this protection; the job pointer did not.
alter table public.time_entries drop constraint if exists time_entries_job_id_fkey;
alter table public.time_entries drop constraint if exists time_entries_job_same_owner;
alter table public.time_entries
  add constraint time_entries_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete set null (job_id)
  not valid;
alter table public.time_entries validate constraint time_entries_job_same_owner;

-- ── 4. job_line_items — priced extras on a visit ─────────────────────────────
-- CASCADE here, unchanged: an extra is part of the visit and has no meaning
-- without it, whereas an expense is money that left the bank whatever happens to
-- the job. Two different facts, two different deletion rules, both preserved.
alter table public.job_line_items drop constraint if exists job_line_items_job_id_fkey;
alter table public.job_line_items drop constraint if exists job_line_items_job_same_owner;
alter table public.job_line_items
  add constraint job_line_items_job_same_owner
  foreign key (job_id, user_id) references public.jobs(id, user_id)
  on delete cascade
  not valid;
alter table public.job_line_items validate constraint job_line_items_job_same_owner;

commit;

-- ── Proof ────────────────────────────────────────────────────────────────────
-- Expect three rows, each naming BOTH columns:
--
--   select conrelid::regclass, conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conname in ('expenses_job_same_owner',
--                     'time_entries_job_same_owner',
--                     'job_line_items_job_same_owner');
