-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811075519
--   name    : service_bundles_v1
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

alter table public.service_templates
  add constraint service_templates_id_user_uk unique (id, user_id);

create table public.service_bundles (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  sort_order  integer not null default 0,
  constraint service_bundles_name_not_blank check (btrim(name) <> ''),
  constraint service_bundles_id_user_uk unique (id, user_id)
);

create unique index service_bundles_user_name_uk
  on public.service_bundles (user_id, lower(btrim(name)));
create index service_bundles_user_sort_idx
  on public.service_bundles (user_id, sort_order, created_at);

create trigger service_bundles_updated_at
  before update on public.service_bundles
  for each row execute function handle_updated_at();

create table public.service_bundle_items (
  id         uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  bundle_id  uuid not null,
  service_template_id uuid,
  name       text not null,
  quantity   numeric not null default 1,
  unit       text,
  unit_price numeric,
  est_minutes integer,
  notes      text,
  kind       text not null default 'service',
  sort_order integer not null default 0,
  constraint service_bundle_items_name_not_blank check (btrim(name) <> ''),
  constraint service_bundle_items_quantity_positive check (quantity > 0),
  constraint service_bundle_items_price_not_negative
    check (unit_price is null or unit_price >= 0),
  constraint service_bundle_items_minutes_not_negative
    check (est_minutes is null or est_minutes >= 0),
  constraint service_bundle_items_kind_check check (kind in ('service', 'material')),
  constraint service_bundle_items_bundle_same_owner
    foreign key (bundle_id, user_id)
    references public.service_bundles (id, user_id) on delete cascade,
  constraint service_bundle_items_template_same_owner
    foreign key (service_template_id, user_id)
    references public.service_templates (id, user_id)
    on delete set null (service_template_id)
);

create index service_bundle_items_bundle_idx
  on public.service_bundle_items (bundle_id, sort_order, created_at);

alter table public.service_bundles       enable row level security;
alter table public.service_bundle_items  enable row level security;

create policy "bundles: select own" on public.service_bundles
  for select using (auth.uid() = user_id);
create policy "bundles: insert own" on public.service_bundles
  for insert with check (auth.uid() = user_id);
create policy "bundles: update own" on public.service_bundles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bundles: delete own" on public.service_bundles
  for delete using (auth.uid() = user_id);

create policy "bundle items: select own" on public.service_bundle_items
  for select using (auth.uid() = user_id);
create policy "bundle items: insert own" on public.service_bundle_items
  for insert with check (auth.uid() = user_id);
create policy "bundle items: update own" on public.service_bundle_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bundle items: delete own" on public.service_bundle_items
  for delete using (auth.uid() = user_id);