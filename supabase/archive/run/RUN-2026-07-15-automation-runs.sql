-- ── automation_runs — the engine's run log ───────────────────────────────────
-- Every rule evaluation, FIRED OR SUPPRESSED, with the reason. If it isn't in
-- here, it didn't happen.
--
-- The suppressed rows are the point. "Nothing happened" is the hardest thing to
-- debug in an automation and the easiest thing to distrust, so the engine records
-- why it stayed quiet — not just when it spoke.
--
-- Depends on RUN-2026-07-14-automation-signals.sql. Safe to run more than once.

create table if not exists public.automation_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Which rule was evaluated (lib/automation/rules.ts).
  rule_key      text not null,
  -- The signal row that triggered the evaluation, when there was one.
  signal_id     uuid references public.automation_signals(id) on delete set null,
  subject_type  text,
  subject_id    uuid,
  evaluated_on  date not null,
  decision      text not null check (decision in ('fired', 'suppressed')),
  -- Why it stayed quiet. 'mode_suggest' = the condition was real and the rule saw
  -- it, but the owner hasn't granted it authority to act — which is every rule
  -- today, by design.
  suppressed_reason text check (suppressed_reason in (
    'mode_off', 'mode_suggest', 'quiet_hours', 'frequency_cap', 'no_consent', 'deduped', 'signal_absent'
  )),
  created_at    timestamptz not null default now()
);

-- ONE evaluation per rule, per subject, per day — re-running the engine is a
-- no-op, the same contract the signal sweep uses.
create unique index if not exists automation_runs_unique
  on public.automation_runs (user_id, rule_key, subject_id, evaluated_on);

-- The read pattern: "what did the engine do today, and why?"
create index if not exists automation_runs_lookup
  on public.automation_runs (user_id, evaluated_on desc, rule_key);

alter table public.automation_runs enable row level security;

-- Owners read their own run log (the future Automation Center). Writes are
-- service-role only: the engine is the single writer, so nothing else can claim
-- an automation ran.
drop policy if exists "own runs read" on public.automation_runs;
create policy "own runs read" on public.automation_runs
  for select using (auth.uid() = user_id);

revoke insert, update, delete on public.automation_runs from anon, authenticated;
