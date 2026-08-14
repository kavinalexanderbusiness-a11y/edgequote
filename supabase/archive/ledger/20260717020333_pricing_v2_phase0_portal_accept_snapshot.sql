-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717020333
--   name    : pricing_v2_phase0_portal_accept_snapshot
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Pricing v2 · Phase 0 · the CUSTOMER-side half of the accept sensor.
--
-- portal_accept_quote set status='accepted' and recorded nothing else — so a sale
-- made by the customer (the most trustworthy acceptance there is: they clicked it
-- themselves) taught the learner nothing at all.
--
-- accepted_price is snapshotted from the quote's OWN total inside the same UPDATE.
-- Doing it in SQL rather than passing a price from the client is deliberate: a
-- portal caller must never be able to tell the server what it agreed to pay.
--
-- selected_cadence stays NULL: the portal's accept button says "yes to this quote",
-- not "yes to weekly". Recording a guess here would defeat the column's purpose.
-- Signature is UNCHANGED (p_token, p_quote_id) — the portal client needs no edit.

create or replace function public.portal_accept_quote(p_token text, p_quote_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.quotes
     set status = 'accepted',
         -- Snapshot the agreed number from the row itself, at the instant of consent.
         accepted_price = coalesce(accepted_price, total)
   where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end; $function$;