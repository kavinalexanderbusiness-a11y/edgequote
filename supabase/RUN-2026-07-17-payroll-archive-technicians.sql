-- ── PAY-1: a technician can be removed without deleting the payroll record ────
-- Launch blocker PAY-1 (Critical). Removing a technician CASCADE-deleted their
-- time_entries, wage_history and pto_entries. Those are the hours someone worked
-- and the wage they were paid — records with a statutory retention period
-- (~3 years, Canada; longer in some provinces). One tap on "Remove" destroyed
-- them irreversibly, and the confirm dialog said "Job history is untouched."
--
-- ⚠️ APPLIED + VERIFIED in production 2026-07-17 via MCP (before AND after, plus a
-- negative test proving a delete now PRESERVES the payroll rows — see the bottom).
--
-- THE PATTERN — copied from `pay_run_lines`, which already had this right:
--     FOREIGN KEY (technician_id, user_id) REFERENCES technicians(id, user_id)
--       ON DELETE SET NULL (technician_id)
-- Column-scoped SET NULL (PG 15+). It nulls ONLY technician_id and leaves user_id
-- intact, so the row keeps its tenant and stays visible to RLS and to every
-- payroll report. A bare `ON DELETE SET NULL` would null user_id too and strand
-- the row outside its owner's data — a leak dressed up as a fix.
--
-- ⭐ THE PATTERN IS TWO PARTS, AND COPYING ONLY THE FK WOULD SHIP A BROKEN FIX.
-- `pay_run_lines.technician_id` is NULLABLE; on these three tables it was NOT
-- NULL. A column-scoped SET NULL against a NOT NULL column does not preserve the
-- row — the delete aborts with a not-null violation. The constraint would look
-- correct in the schema and behave as a hard block at runtime. So the NOT NULL
-- comes off first. `user_id` stays NOT NULL on all of them (it is never nulled).
--
-- Deliberately NOT done: no ON DELETE CASCADE anywhere in this file, and no
-- backfill. There is nothing to backfill — all four tables are empty today, which
-- is exactly why this is cheap now. The window shuts on the first payroll row.

-- ── 1. Archive, so removal stops being a delete at all ───────────────────────
-- The FK change makes deletion survivable; archiving makes it unnecessary. Same
-- shape as customers.archived_at (soft-archive: hidden, fully preserved,
-- NULL = active) — the app's existing pattern, not a second one.
alter table public.technicians
  add column if not exists archived_at timestamptz;

comment on column public.technicians.archived_at is
  'Soft-archive: set when the technician leaves the roster (hidden everywhere, '
  'record preserved). NULL = active. Removing a technician must archive, never '
  'delete — their time_entries/wage_history/pto_entries are statutory records.';

-- Partial index: every active-roster read filters on this, and archived rows are
-- the minority that stays out of the way.
create index if not exists technicians_active_idx
  on public.technicians (user_id)
  where archived_at is null;

-- ── 2. technician_id must be nullable for a column-scoped SET NULL to work ────
-- Without this the FK below is a hard delete-block, not a history-preserving
-- rule. Widening only — no data is touched, and user_id stays NOT NULL.
alter table public.time_entries alter column technician_id drop not null;
alter table public.wage_history alter column technician_id drop not null;
alter table public.pto_entries  alter column technician_id drop not null;

-- ── 3. CASCADE → column-scoped SET NULL, matching pay_run_lines exactly ───────
-- Same constraint names, so the "_same_owner" composite-FK contract (a child row
-- can only reference a technician belonging to the same user) is preserved. Only
-- the delete rule changes.
alter table public.time_entries
  drop constraint if exists time_entries_technician_same_owner;
alter table public.time_entries
  add constraint time_entries_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

alter table public.wage_history
  drop constraint if exists wage_history_technician_same_owner;
alter table public.wage_history
  add constraint wage_history_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

alter table public.pto_entries
  drop constraint if exists pto_entries_technician_same_owner;
alter table public.pto_entries
  add constraint pto_entries_technician_same_owner
  foreign key (technician_id, user_id) references public.technicians(id, user_id)
  on delete set null (technician_id);

-- ── Verification (run after applying) ────────────────────────────────────────
-- Expect all four to read `ON DELETE SET NULL (technician_id)` — the three fixed
-- here plus pay_run_lines, which was already correct:
--   select rel.relname, pg_get_constraintdef(con.oid)
--   from pg_constraint con
--   join pg_class rel on rel.oid = con.conrelid
--   join pg_class ref on ref.oid = con.confrelid
--   where con.contype='f' and ref.relname='technicians'
--   order by rel.relname;
--
-- Expect technician_id nullable / user_id NOT NULL on all three:
--   select table_name, column_name, is_nullable from information_schema.columns
--   where table_schema='public'
--     and table_name in ('time_entries','wage_history','pto_entries')
--     and column_name in ('technician_id','user_id')
--   order by table_name, column_name;
--
-- NEGATIVE TEST (the one that actually proves it — run in a transaction and roll
-- back): insert a technician + one row in each child table, delete the
-- technician, and assert all three child rows still exist with technician_id
-- NULL and user_id unchanged. Before this migration the same test returned three
-- deleted rows.
