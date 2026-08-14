-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260810030326
--   name    : portal_access_requests
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.portal_access_requests (
  id          uuid primary key default uuid_generate_v4(),
  email_key   text        not null,
  created_at  timestamptz not null default now(),
  matched     boolean     not null default false,
  sent        boolean     not null default false
);

alter table public.portal_access_requests enable row level security;

create index if not exists portal_access_requests_key_time_idx
  on public.portal_access_requests (email_key, created_at desc);
create index if not exists portal_access_requests_time_idx
  on public.portal_access_requests (created_at desc);

comment on table public.portal_access_requests is
  'Abuse ledger for the public portal-link endpoint. email_key = sha256(lower(trim(email))) — never the address. No customer_id/user_id/token by design.';