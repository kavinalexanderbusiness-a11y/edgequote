-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716233203
--   name    : phone_search_digits_2026_07_16
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

alter table public.customers
  add column if not exists phone_digits text
  generated always as (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) stored;

comment on column public.customers.phone_digits is
  'Digits-only form of phone, for search only. Generated — never write to it. Display and dial from `phone`, which keeps the owner''s own formatting.';

create extension if not exists pg_trgm;

create index if not exists customers_phone_digits_trgm_idx
  on public.customers using gin (phone_digits gin_trgm_ops);