-- ── Portal: let "No thanks" actually mean no ─────────────────────────────────
--
-- WHY
-- The portal's review card offers three answers: leave a review, "Already did",
-- or "No thanks". The first two were wired to something. The third was React
-- state — `setDismissed(true)` — that died with the tab.
--
-- So a customer who declined got asked again on their next visit, AND kept
-- receiving review-request texts and emails, because api/cron/notifications
-- suppresses on customers.review_declined_at:
--
--     if (template === 'review_request' && (c.reviewed_at || c.review_declined_at)) continue
--
-- and nothing the customer could touch was able to write that column. The owner's
-- ReviewLifecycle could set it; the person actually being asked could not. A door
-- that opens onto a wall is worse than no door — they used it, and we kept knocking.
--
-- WHAT CHANGES
-- One token-scoped RPC, mirroring portal_mark_reviewed exactly (security definer,
-- pinned search_path, boolean result, invalid/revoked token → false). It sets the
-- SAME column the owner's decline already sets, which the cron ALREADY honours —
-- no new rule, no second definition of "don't ask this person again".
--
-- coalesce() means a second decline never moves the original timestamp, matching
-- portal_mark_reviewed's treatment of reviewed_at.
--
-- Note: reviewed_at is deliberately NOT touched here. Declining is not reviewing,
-- and conflating them would tell the owner they'd received a review they hadn't.
--
-- SAFETY
-- Additive (new function only). No column is created — customers.review_declined_at
-- has existed since RUN-2026-06-25h-crm-automation.sql. No data is backfilled: nobody
-- has declined yet, and inventing declines would silence asks the customer never
-- refused. Re-runnable (create or replace).
--
-- Pairs with RUN-2026-07-15-portal-quote-expiry.sql, which adds review_declined_at to
-- the get_portal_data customer projection so a saved decline keeps the card down on
-- the next visit. That file is THE canonical get_portal_data — never replace the
-- function from an older file in that chain.

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
