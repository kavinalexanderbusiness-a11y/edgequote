-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715083535
--   name    : portal_decline_review
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- RUN-2026-07-15-portal-decline-review.sql
-- The portal's "No thanks" on the review card was session-local React state: the
-- card came back next visit, and api/cron/notifications kept sending review
-- requests, because that cron suppresses on customers.review_declined_at and
-- nothing in the portal could write it. The customer said no; we kept asking.
--
-- The rule already exists and is NOT duplicated here: the owner's
-- ReviewLifecycle writes the same column, and the cron already reads it
-- (`if (template === 'review_request' && (c.reviewed_at || c.review_declined_at)) continue`).
-- This only lets the CUSTOMER emit the signal the system already honours.
--
-- Mirrors portal_mark_reviewed exactly — token-scoped, security definer, coalesce
-- so a second decline never moves the original timestamp. Idempotent.
create or replace function public.portal_decline_review(p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.customers
    set review_declined_at = coalesce(review_declined_at, now())
    where id = v_customer;
  return true;
end; $$;

grant execute on function public.portal_decline_review(text) to anon, authenticated;