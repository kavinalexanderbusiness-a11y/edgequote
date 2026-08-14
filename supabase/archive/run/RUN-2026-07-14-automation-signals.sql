-- ── automation_signals — the detection ledger ────────────────────────────────
-- What /api/cron/signals writes: "this condition was true for this subject on
-- this day". Nothing consumes it yet — it is the seam future automations read
-- from, so a rule never re-derives a condition (which is how six screens ended up
-- disagreeing about who had churned).
--
-- Safe to run more than once.

create table if not exists public.automation_signals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Which detector fired, e.g. 'recurring_ran_out' | 'churn_risk'.
  signal        text not null,
  -- What it fired about. 'customer' today; quotes/invoices/properties later.
  subject_type  text not null,
  subject_id    uuid not null,
  -- The LOCAL day it was evaluated (not a timestamp) — the sweep is daily, and
  -- this is what makes a re-run idempotent.
  detected_on   date not null,
  -- The detector's own detail (daysSince, ratio, cadence…). Deliberately loose:
  -- each signal owns its shape, and the engine only needs the key + subject.
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- ONE row per signal, per subject, per day. This is the idempotency contract the
-- sweep's upsert relies on: re-running the cron is a no-op, not a pile of rows.
create unique index if not exists automation_signals_unique
  on public.automation_signals (user_id, signal, subject_id, detected_on);

-- The read pattern: "what is true for me today?"
create index if not exists automation_signals_lookup
  on public.automation_signals (user_id, signal, detected_on desc);

alter table public.automation_signals enable row level security;

-- Owners read their own signals (a future Automation Center run log). Writes are
-- service-role only — the sweep is the single writer, so nothing else can invent
-- a signal that no detector actually produced.
drop policy if exists "own signals read" on public.automation_signals;
create policy "own signals read" on public.automation_signals
  for select using (auth.uid() = user_id);

revoke insert, update, delete on public.automation_signals from anon, authenticated;
