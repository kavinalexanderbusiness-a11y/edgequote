-- ── Scheduled messages: one-off "send later" queue for THE comms pipeline ─────
-- The Communications Center's Scheduled tab + the Send-later mode in the shared
-- SendMessageDialog write rows here; /api/cron/scheduled-messages claims due rows
-- (CAS on status) and sends through the SAME engines every other sender uses
-- (renderMessage/renderBody → dispatchToCustomer → logDispatch). No second
-- pipeline: consent, threading and notification_log auditing all happen inside
-- dispatch, exactly as they do for campaigns and manual sends.
--
-- body IS NULL      → the template renders per customer AT SEND TIME (fresh
--                     name/portal link, plus any template edits made meanwhile).
-- body IS NOT NULL  → the owner's edited text, sent as written ({{tokens}} still
--                     interpolate per customer, same as bodyOverride on /api/comms/send).

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
  -- pending → sending (claimed by a cron run) → sent | skipped | failed.
  -- 'canceled' is owner-set and only ever replaces 'pending' (CAS both ways, so
  -- a cancel racing the cron has exactly one winner).
  status      text not null default 'pending',
  -- When the cron took the claim. Stale-claim detection keys on THIS, never on
  -- send_at — a backlogged row (due long ago, claimed seconds ago) is not stale.
  claimed_at  timestamptz,
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

-- The cron's due-scan (status = 'pending' and send_at <= now()) and the
-- Scheduled tab's per-owner list.
create index if not exists scheduled_messages_due_idx  on public.scheduled_messages (status, send_at);
create index if not exists scheduled_messages_user_idx on public.scheduled_messages (user_id, send_at desc);
