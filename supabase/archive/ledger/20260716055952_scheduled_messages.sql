-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716055952
--   name    : scheduled_messages
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- Scheduled messages: one-off "send later" queue for THE comms pipeline.
-- Written by the shared SendMessageDialog; sent by /api/cron/scheduled-messages
-- through renderMessage/renderBody → dispatchToCustomer → logDispatch.

create table if not exists public.scheduled_messages (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete set null,
  template    text not null,
  channels    text[] not null default '{sms,email}',
  body        text,
  vars        jsonb,
  send_at     timestamptz not null,
  status      text not null default 'pending',
  sent_at     timestamptz,
  detail      text,
  message_id  uuid references public.messages(id) on delete set null
);

alter table public.scheduled_messages enable row level security;

drop policy if exists "scheduled_messages_select_own" on public.scheduled_messages;
create policy "scheduled_messages_select_own" on public.scheduled_messages
  for select using (auth.uid() = user_id);
drop policy if exists "scheduled_messages_insert_own" on public.scheduled_messages;
create policy "scheduled_messages_insert_own" on public.scheduled_messages
  for insert with check (auth.uid() = user_id);
drop policy if exists "scheduled_messages_update_own" on public.scheduled_messages;
create policy "scheduled_messages_update_own" on public.scheduled_messages
  for update using (auth.uid() = user_id);
drop policy if exists "scheduled_messages_delete_own" on public.scheduled_messages;
create policy "scheduled_messages_delete_own" on public.scheduled_messages
  for delete using (auth.uid() = user_id);

create index if not exists scheduled_messages_due_idx  on public.scheduled_messages (status, send_at);
create index if not exists scheduled_messages_user_idx on public.scheduled_messages (user_id, send_at desc);