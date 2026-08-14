-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716234632
--   name    : balance_sheet_foundation
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- A/P split: an expense can be INCURRED without being PAID.
alter table public.expenses add column if not exists bill_date date;
update public.expenses set bill_date = spent_at where bill_date is null;
alter table public.expenses alter column bill_date set not null;
alter table public.expenses alter column spent_at drop not null;

comment on column public.expenses.bill_date is
  'When the cost was INCURRED (accrual date). Always set.';
comment on column public.expenses.spent_at is
  'When the CASH LEFT. NULL = unpaid = accounts payable. Cash-basis reports filter on this.';

create index if not exists expenses_user_unpaid_idx
  on public.expenses(user_id, bill_date)
  where spent_at is null and archived_at is null;
create index if not exists expenses_user_bill_date_idx
  on public.expenses(user_id, bill_date desc)
  where archived_at is null;

-- Opening balances.
alter table public.business_settings
  add column if not exists opening_bank_balance numeric(12,2),
  add column if not exists opening_balance_date date,
  add column if not exists opening_equity numeric(12,2);

comment on column public.business_settings.opening_bank_balance is
  'Bank balance as at opening_balance_date. Cash = this + every movement since.';
comment on column public.business_settings.opening_balance_date is
  'The date opening_bank_balance was true. Cash movements before it are ignored.';
comment on column public.business_settings.opening_equity is
  'Owner capital already in the business at the opening date. NULL = unknown (never plugged).';

-- Fixed assets.
create table if not exists public.fixed_assets (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null,
  equipment_id      uuid references public.equipment(id) on delete set null,
  vendor_id         uuid references public.vendors(id) on delete set null,
  cost              numeric(12,2) not null check (cost >= 0),
  tax_amount        numeric(12,2) not null default 0 check (tax_amount >= 0),
  in_service_date   date not null,
  method            text not null default 'straight_line'
                    check (method in ('straight_line', 'declining_balance', 'none')),
  useful_life_years numeric(4,1) check (useful_life_years > 0),
  salvage_value     numeric(12,2) not null default 0 check (salvage_value >= 0),
  declining_rate    numeric(5,2) check (declining_rate > 0 and declining_rate <= 100),
  disposed_at       date,
  disposal_proceeds numeric(12,2),
  notes             text,
  archived_at       timestamptz,
  constraint fixed_assets_sl_needs_life
    check (method <> 'straight_line' or useful_life_years is not null),
  constraint fixed_assets_db_needs_rate
    check (method <> 'declining_balance' or declining_rate is not null),
  constraint fixed_assets_salvage_within_cost check (salvage_value <= cost),
  constraint fixed_assets_tax_within_cost check (tax_amount <= cost),
  constraint fixed_assets_disposal_after_service
    check (disposed_at is null or disposed_at >= in_service_date)
);
create index if not exists fixed_assets_user_idx
  on public.fixed_assets(user_id, in_service_date desc) where archived_at is null;
create index if not exists fixed_assets_user_active_idx
  on public.fixed_assets(user_id) where archived_at is null and disposed_at is null;
create index if not exists fixed_assets_equipment_idx
  on public.fixed_assets(equipment_id) where equipment_id is not null;

-- Liabilities.
create table if not exists public.liabilities (
  id              uuid primary key default uuid_generate_v4(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  kind            text not null default 'loan'
                  check (kind in ('loan', 'credit_card', 'line_of_credit', 'other')),
  current_balance numeric(12,2) not null check (current_balance >= 0),
  as_of_date      date not null,
  interest_rate   numeric(5,2) check (interest_rate >= 0),
  notes           text,
  archived_at     timestamptz
);
create index if not exists liabilities_user_idx
  on public.liabilities(user_id, as_of_date desc) where archived_at is null;

alter table public.fixed_assets enable row level security;
alter table public.liabilities  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fixed_assets', 'liabilities'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': select own') then
      execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', t || ': select own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': insert own') then
      execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', t || ': insert own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': update own') then
      execute format('create policy %I on public.%I for update using (auth.uid() = user_id)', t || ': update own', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || ': delete own') then
      execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', t || ': delete own', t);
    end if;
  end loop;
end $$;

drop trigger if exists trg_fixed_assets_updated on public.fixed_assets;
create trigger trg_fixed_assets_updated before update on public.fixed_assets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_liabilities_updated on public.liabilities;
create trigger trg_liabilities_updated before update on public.liabilities
  for each row execute function public.set_updated_at();