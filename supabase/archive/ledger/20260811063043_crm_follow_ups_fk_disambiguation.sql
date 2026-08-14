-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811063043
--   name    : crm_follow_ups_fk_disambiguation
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- The composite (user_id, X) FKs already guarantee existence AND same-tenant, so
-- the single-column ones are redundant — and their redundancy is not free:
-- PostgREST resolves an embedded `customers(...)` by finding THE relationship
-- between the two tables, and two FKs to the same table make that ambiguous, so
-- the queue's read failed outright.
alter table public.follow_ups drop constraint follow_ups_customer_id_fkey;
alter table public.follow_ups drop constraint follow_ups_quote_id_fkey;

-- That single-column quote FK was also masking a real defect. A composite
-- `on delete set null` with no column list nulls EVERY referencing column, and
-- user_id is NOT NULL — so once the redundant FK is gone, deleting a quote would
-- have raised instead of clearing the link. PG15+ takes a column list; name the
-- one column that may be nulled.
alter table public.follow_ups drop constraint follow_ups_quote_same_tenant;
alter table public.follow_ups
  add constraint follow_ups_quote_same_tenant
  foreign key (user_id, quote_id) references public.quotes (user_id, id)
  on delete set null (quote_id);