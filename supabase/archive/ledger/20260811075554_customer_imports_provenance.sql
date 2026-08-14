-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811075554
--   name    : customer_imports_provenance
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

create table if not exists public.customer_imports (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  initiated_by          text,
  source_name           text,
  rows_detected         integer not null default 0,
  customers_created     integer not null default 0,
  rows_skipped_existing integer not null default 0,
  rows_failed           integer not null default 0,
  properties_created    integer not null default 0,
  constraint customer_imports_counts_sane check (
    rows_detected >= 0 and customers_created >= 0 and rows_skipped_existing >= 0
    and rows_failed >= 0 and properties_created >= 0
  ),
  constraint customer_imports_source_name_len check (source_name is null or char_length(source_name) <= 200),
  constraint customer_imports_initiated_by_len check (initiated_by is null or char_length(initiated_by) <= 200)
);

alter table public.customer_imports enable row level security;

drop policy if exists "customer_imports: select own" on public.customer_imports;
create policy "customer_imports: select own" on public.customer_imports
  for select using (auth.uid() = user_id);

drop policy if exists "customer_imports: insert own" on public.customer_imports;
create policy "customer_imports: insert own" on public.customer_imports
  for insert with check (auth.uid() = user_id);

create index if not exists customer_imports_user_created_idx
  on public.customer_imports(user_id, created_at desc);