-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260718063846
--   name    : bk1_intake_helpers_revoke_public_exec
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- The two intake helpers take p_user (a tenant id) as an ARGUMENT, so any caller who
-- can execute them names the tenant. They are only ever called from inside the two
-- SECURITY DEFINER intake RPCs, where the effective user is the function owner and
-- these grants are irrelevant. Supabase's default privileges hand EXECUTE to anon and
-- authenticated on every new public-schema function, so `revoke ... from public` is
-- not enough — the explicit role grants have to go too. RLS on customers/properties
-- would very likely have stopped a direct anon call anyway; this removes the question.
revoke all on function public.resolve_intake_customer(uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_intake_property(uuid, uuid, text, text, text, text, double precision, double precision, numeric, jsonb, text, text, numeric, numeric) from public, anon, authenticated;