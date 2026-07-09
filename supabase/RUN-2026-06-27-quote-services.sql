-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Multi-service quotes: quote_services child table.
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- A quote can now hold ONE OR MANY services. Mirrors the job_line_items child-
-- table conventions (RLS, indexes). BACKWARD COMPATIBLE by design:
--   • When rows exist, they are the source of truth for the service breakdown;
--     quotes.service_type / quotes.initial_price are written as derived caches
--     (primary label + summed NET of all lines) on every save, so the GENERATED
--     quotes.total (initial_price + travel_fee) — and every consumer that reads
--     it (PDF, portal, invoice conversion, job pricing) — stays correct.
--   • Legacy quotes (no rows) behave exactly as before.
-- Discount semantics match invoices ('amount' | 'percent', applied per line).

create table if not exists public.quote_services (
  id                  uuid primary key default uuid_generate_v4(),
  created_at          timestamptz not null default now(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  service_type        text not null,
  service_template_id uuid references public.service_templates(id) on delete set null,
  quantity            numeric not null default 1,
  unit                text,                                -- each | hour | sqft | linear_ft
  unit_price          numeric not null default 0,          -- customer-facing (fee recovery baked in at creation)
  est_minutes         int,                                 -- estimated duration for this line
  discount_type       text check (discount_type in ('amount','percent')),
  discount_value      numeric,
  notes               text,
  sort_order          int not null default 0               -- 0 = the primary service
);

alter table public.quote_services enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quote_services' and policyname='quote_services: select own') then
    create policy "quote_services: select own" on public.quote_services for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quote_services' and policyname='quote_services: insert own') then
    create policy "quote_services: insert own" on public.quote_services for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quote_services' and policyname='quote_services: update own') then
    create policy "quote_services: update own" on public.quote_services for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quote_services' and policyname='quote_services: delete own') then
    create policy "quote_services: delete own" on public.quote_services for delete using (auth.uid() = user_id);
  end if;
end $$;

create index if not exists quote_services_user_quote_idx on public.quote_services(user_id, quote_id);
create index if not exists quote_services_quote_sort_idx on public.quote_services(quote_id, sort_order);
