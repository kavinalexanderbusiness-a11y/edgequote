-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053258
--   name    : change_orders_v1_money_link
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.job_line_items add column if not exists change_order_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_line_items_change_order_same_owner') then
    alter table public.job_line_items
      add constraint job_line_items_change_order_same_owner
      foreign key (change_order_id, user_id) references public.change_orders (id, user_id) on delete cascade;
  end if;
end $$;

create unique index if not exists job_line_items_change_order_uniq
  on public.job_line_items (change_order_id) where change_order_id is not null;

comment on column public.job_line_items.change_order_id is
  'Set only by change_order_apply_approval(). Its presence means this money exists BECAUSE a customer approved a change order - never hand-write it.';

drop policy if exists "job_line_items: delete own" on public.job_line_items;
create policy "job_line_items: delete own" on public.job_line_items
  for delete using (auth.uid() = user_id and change_order_id is null);

drop policy if exists "job_line_items: insert own" on public.job_line_items;
create policy "job_line_items: insert own" on public.job_line_items
  for insert with check (auth.uid() = user_id and change_order_id is null);

drop policy if exists "job_line_items: update own" on public.job_line_items;
create policy "job_line_items: update own" on public.job_line_items
  for update using (auth.uid() = user_id and change_order_id is null)
  with check (auth.uid() = user_id and change_order_id is null);