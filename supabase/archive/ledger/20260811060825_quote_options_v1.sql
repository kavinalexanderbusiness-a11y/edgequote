-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811060825
--   name    : quote_options_v1
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

create table if not exists public.quote_options (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  description text,
  price numeric(10,2) not null check (price >= 0),
  sort_order int not null default 0,
  is_recommended boolean not null default false,
  constraint quote_options_id_quote_unique unique (id, quote_id)
);

create index if not exists quote_options_quote_idx on public.quote_options (quote_id, sort_order);
create index if not exists quote_options_user_idx on public.quote_options (user_id);
create unique index if not exists quote_options_one_recommended
  on public.quote_options (quote_id) where is_recommended;

alter table public.quote_options enable row level security;

drop policy if exists "quote_options: select own" on public.quote_options;
drop policy if exists "quote_options: insert own" on public.quote_options;
drop policy if exists "quote_options: update own" on public.quote_options;
drop policy if exists "quote_options: delete own" on public.quote_options;
create policy "quote_options: select own" on public.quote_options for select using (auth.uid() = user_id);
create policy "quote_options: insert own" on public.quote_options for insert with check (auth.uid() = user_id);
create policy "quote_options: update own" on public.quote_options for update using (auth.uid() = user_id);
create policy "quote_options: delete own" on public.quote_options for delete using (auth.uid() = user_id);

alter table public.quotes add column if not exists selected_option_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_selected_option_fkey') then
    alter table public.quotes
      add constraint quotes_selected_option_fkey
      foreign key (selected_option_id, id)
      references public.quote_options (id, quote_id)
      on delete restrict;
  end if;
end $$;

create index if not exists quotes_selected_option_idx on public.quotes (selected_option_id);

create or replace function public.quote_options_shape_guard() returns trigger
language plpgsql
set search_path to 'public'
as $$
declare v_quote uuid; v_options int; v_lines int;
begin
  v_quote := coalesce(new.quote_id, old.quote_id);
  if v_quote is null then return null; end if;
  if not exists (select 1 from public.quotes where id = v_quote) then return null; end if;

  select count(*) into v_options from public.quote_options where quote_id = v_quote;
  select count(*) into v_lines   from public.quote_services where quote_id = v_quote;

  if v_options > 4 then
    raise exception 'A quote may offer at most 4 options (this one would have %)', v_options
      using errcode = 'check_violation';
  end if;

  if v_options > 0 and v_lines > 0 then
    raise exception 'A quote cannot have both alternative options and additive service lines'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists quote_options_shape_trg on public.quote_options;
create constraint trigger quote_options_shape_trg
  after insert or update or delete on public.quote_options
  deferrable initially deferred
  for each row execute function public.quote_options_shape_guard();

drop trigger if exists quote_services_shape_trg on public.quote_services;
create constraint trigger quote_services_shape_trg
  after insert or update on public.quote_services
  deferrable initially deferred
  for each row execute function public.quote_options_shape_guard();

comment on table public.quote_options is
  'Mutually exclusive alternatives for one quote (Budget/Recommended/Premium). NOT additive: quotes.initial_price always equals ONE option price - the recommended one before the customer chooses, the selected one after. Cannot coexist with quote_services rows.';
comment on column public.quotes.selected_option_id is
  'The option the customer approved. Composite FK guarantees it belongs to THIS quote; ON DELETE RESTRICT keeps the approved alternative on the record permanently.';