-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715095703
--   name    : automation_sweeps
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── automation_sweeps — proof that a cron ran ────────────────────────────────
-- The signal ledger records what was DETECTED. It cannot record that nothing was
-- detected, which makes four completely different states byte-identical:
--
--     swept and found nothing   0 rows, 200, silent
--     never deployed            0 rows,  — , silent
--     crashed on owner 1 of 40  0 rows, 500, silent
--     service key missing       0 rows, 200, silent   <- the worst one
--
-- Zero rows is the PLAUSIBLE HAPPY PATH here: two rules, narrow conditions, a small
-- book. So the Automation Center was asserting "the crons haven't run yet" — a claim
-- the data cannot support — on the exact screen a healthy quiet night produces. Day
-- one would have trained the operator to dismiss the only warning that ever matters.
--
-- One row per job per day, written UNCONDITIONALLY at every exit including the
-- failure paths. `ok=false` + `error` is how a broken sweep says so out loud instead
-- of looking like a quiet one. This is the heartbeat; the signal rows are the payload.
--
-- Deliberately GLOBAL, not per-owner: the sweep loops over every owner in one
-- invocation, so per-owner liveness was never a fact about the cron. The old
-- inference read one owner's emptiness as the cron being dead, which is invalid even
-- when it is provably alive.
--
-- Read-only to owners, like the other two ledgers: the crons are the only writers.
-- Applied to prod 2026-07-15 via MCP.

create table if not exists public.automation_sweeps (
  job        text        not null,
  ran_on     date        not null,
  ran_at     timestamptz not null default now(),
  ok         boolean     not null,
  owners     integer,
  detected   integer,
  written    integer,
  ms         integer,
  error      text,
  request_id text,
  primary key (job, ran_on)
);

alter table public.automation_sweeps enable row level security;

drop policy if exists "own sweeps read" on public.automation_sweeps;
create policy "own sweeps read" on public.automation_sweeps
  for select to authenticated using (true);

revoke insert, update, delete on public.automation_sweeps from anon, authenticated;