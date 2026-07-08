-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Message-send idempotency guard. Idempotent + additive — safe to re-run.
-- Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- One reservation row per LOGICAL send, keyed by a client-generated
-- client_message_id that the caller reuses across every retry / offline replay /
-- concurrent tab. The composite PRIMARY KEY (user_id, client_message_id) is the
-- atomic guard: the FIRST claim wins the insert; every later attempt with the same
-- id fails with 23505 (unique_violation), which claimSend() reads as "already
-- handled → do NOT resend". This makes the external SMS/email side-effect
-- at-most-once EVEN WITHOUT app-level locks, because the database is the single
-- serialization point — closing the residual concurrent-replay window that the
-- outbox's Web-Locks path could not cover on browsers without navigator.locks.
--
-- This is NOT a second messaging system: nothing is sent from here. It is a thin
-- reservation ledger the ONE comms pipeline (/api/messages/send + /api/comms/send)
-- consults before it dispatches. The message bubble + notification_log rows are
-- still written by the existing pipeline, only ever once (only the claim owner
-- proceeds past the guard).

create table if not exists public.message_sends (
  user_id           uuid not null references auth.users(id) on delete cascade,
  client_message_id text not null,
  created_at        timestamptz not null default now(),
  channel           text,   -- primary channel attempted (informational)
  status            text,   -- last recorded outcome: sent | disabled | error | skipped (informational)
  primary key (user_id, client_message_id)
);

alter table public.message_sends enable row level security;
-- Owner-scoped: each caller only ever claims/reads its own reservations. The two
-- send routes run under the owner's session, so auth.uid() = user_id. The cron
-- does NOT use this table (it dedupes via crm_campaign_log.period_key) and the
-- service role bypasses RLS regardless.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='message_sends' and policyname='message_sends: select own') then
    create policy "message_sends: select own" on public.message_sends for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='message_sends' and policyname='message_sends: insert own') then
    create policy "message_sends: insert own" on public.message_sends for insert with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='message_sends' and policyname='message_sends: update own') then
    create policy "message_sends: update own" on public.message_sends for update using (auth.uid() = user_id); end if;
end $$;

-- Cheap age index so a future retention job can prune old reservations (they are
-- only needed for as long as a retry/replay could plausibly arrive — hours, not
-- forever). Not required for correctness.
create index if not exists message_sends_age_idx on public.message_sends(created_at);
