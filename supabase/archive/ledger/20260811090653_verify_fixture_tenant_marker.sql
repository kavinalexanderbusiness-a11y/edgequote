-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811090653
--   name    : verify_fixture_tenant_marker
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

create table if not exists public.verify_fixture_tenants (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  note       text
);

comment on table public.verify_fixture_tenants is
  'Tenants whose data is created by scripts/verify-*.ts. Marker only — grants nothing, relaxes nothing. Guards read it through is_verify_fixture_tenant() and refuse to write when it answers false. Writable only by migration/service_role.';

alter table public.verify_fixture_tenants enable row level security;
revoke all on table public.verify_fixture_tenants from anon, authenticated;

create or replace function public.is_verify_fixture_tenant()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.verify_fixture_tenants t where t.user_id = auth.uid()
  );
$$;

comment on function public.is_verify_fixture_tenant() is
  'True when the CALLER is a verification fixture tenant. Answers only about auth.uid(); takes no arguments so it cannot be used to enumerate or probe. Consulted by scripts/ only — no trigger, policy or application path reads it.';

revoke all on function public.is_verify_fixture_tenant() from public;
revoke all on function public.is_verify_fixture_tenant() from anon;
grant execute on function public.is_verify_fixture_tenant() to authenticated;