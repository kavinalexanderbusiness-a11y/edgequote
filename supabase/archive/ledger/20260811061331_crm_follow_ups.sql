-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811061331
--   name    : crm_follow_ups
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.follow_ups (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  customer_id   uuid        not null references public.customers(id) on delete cascade,
  due_on        date        not null,
  reason        text        not null,
  status        text        not null default 'open',
  completed_at  timestamptz,
  quote_id      uuid        references public.quotes(id) on delete set null,
  source        text        not null default 'customer',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint follow_ups_status_check   check (status in ('open', 'done')),
  constraint follow_ups_source_check   check (source in ('customer', 'quote', 'conversation')),
  constraint follow_ups_reason_check   check (length(btrim(reason)) between 1 and 500),
  constraint follow_ups_completion_consistent check (
    (status = 'open' and completed_at is null)
    or (status = 'done' and completed_at is not null)
  )
);

alter table public.customers add constraint customers_user_id_id_key unique (user_id, id);
alter table public.quotes    add constraint quotes_user_id_id_key    unique (user_id, id);

alter table public.follow_ups
  add constraint follow_ups_customer_same_tenant
  foreign key (user_id, customer_id) references public.customers (user_id, id) on delete cascade;

alter table public.follow_ups
  add constraint follow_ups_quote_same_tenant
  foreign key (user_id, quote_id) references public.quotes (user_id, id) on delete set null;

alter table public.follow_ups enable row level security;

create policy "follow_ups: select own" on public.follow_ups
  for select using (auth.uid() = user_id);
create policy "follow_ups: insert own" on public.follow_ups
  for insert with check (auth.uid() = user_id);
create policy "follow_ups: update own" on public.follow_ups
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "follow_ups: delete own" on public.follow_ups
  for delete using (auth.uid() = user_id);

create index if not exists follow_ups_open_due_idx
  on public.follow_ups (user_id, due_on) where status = 'open';
create index if not exists follow_ups_customer_idx
  on public.follow_ups (user_id, customer_id, due_on desc);

create trigger follow_ups_set_updated_at
  before update on public.follow_ups
  for each row execute function public.handle_updated_at();

comment on table public.follow_ups is
  'Owner follow-up commitments: WHO (customer_id, mandatory) / WHEN (due_on, a local date) / WHY (reason) / open|done. NOT public.schedule_items (empty, unread, calendar-shaped) and NOT lib/followup.ts (the derived quote chaser). Never messages the customer — this is an owner reminder only.';
comment on column public.follow_ups.due_on is
  'A DATE, compared as a string against the owner''s LOCAL today. Never a timestamp — "Friday" must not become Thursday for a traveller.';
comment on column public.follow_ups.completed_at is
  'Set iff status = ''done'', enforced by follow_ups_completion_consistent. Completing retains the row; history is never deleted.';