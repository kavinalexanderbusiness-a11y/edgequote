-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260810030804
--   name    : portal_access_lookup_fn
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.find_portal_access_customers(p_email text)
returns table (customer_id uuid, customer_name text, owner_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id, c.name, c.user_id
  from public.customers c
  where c.archived_at is null
    and c.email is not null
    and lower(trim(c.email)) = lower(trim(p_email))
$$;

revoke all on function public.find_portal_access_customers(text) from public;
revoke all on function public.find_portal_access_customers(text) from anon;
revoke all on function public.find_portal_access_customers(text) from authenticated;

comment on function public.find_portal_access_customers(text) is
  'Portal-link recovery lookup. Normalises both sides (lower+trim). NOT executable by anon/authenticated — service-role only, or the public anon key becomes a customer-existence oracle.';