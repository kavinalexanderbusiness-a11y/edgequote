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
-- Depends on nothing. Idempotent. Applied to prod 2026-07-15 via MCP.

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

-- "Did the cron run" is platform health and safe for any signed-in owner to see.
-- "How many businesses use EdgeQuote" is not. `owners`, `detected` and `written` are
-- GLOBAL aggregates across every tenant, and a row-level policy cannot hide a column
-- — so the policy stays open and the COLUMN GRANTS do the work. Owners get liveness;
-- the counts stay service-role-only, readable by the crons that write them.
drop policy if exists "own sweeps read" on public.automation_sweeps;
create policy "own sweeps read" on public.automation_sweeps
  for select to authenticated using (true);

revoke insert, update, delete on public.automation_sweeps from anon, authenticated;
revoke select on public.automation_sweeps from anon, authenticated;
grant select (job, ran_on, ran_at, ok, error) on public.automation_sweeps to authenticated;
