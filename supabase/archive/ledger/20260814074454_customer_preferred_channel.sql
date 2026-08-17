-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814074454
--   name    : customer_preferred_channel
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.customers
  add column if not exists preferred_channel text;

alter table public.customers
  drop constraint if exists customers_preferred_channel_chk;

alter table public.customers
  add constraint customers_preferred_channel_chk
  check (preferred_channel is null or preferred_channel in ('sms', 'email', 'phone'));

comment on column public.customers.preferred_channel is
  'How the customer prefers to be contacted: sms | email | phone | NULL (no preference). A PREFERENCE, never consent — it orders the channels consent already allows and can never grant one. ''phone'' is an instruction to the owner; the send pipeline never places calls.';