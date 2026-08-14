-- ── Customer V2, M1: constraints + safe attribution ──────────────────────────
-- APPLIED to production 2026-07-16 via MCP (verified before and after).
-- Committed for the repo's migration record — the repo is the source of truth.
--
-- Part of the M0–M4 Customer → Property plan (design in session memory
-- customer-v2-architecture-2026-07-16). ADDITIVE ONLY: no column dropped, no
-- value overwritten, no data invented. customers.address et al survive until
-- M4, which is a separate, owner-gated migration — that's what keeps every
-- unmigrated reader (portal RPC included) working throughout.
--
-- 1. "At most one primary property per customer" becomes a DATABASE constraint
--    instead of an app-side habit. Live data already satisfied it (verified:
--    zero customers with two primaries), so this cannot fail on apply — it
--    exists to stop the FUTURE bug, not to fix a present one.
create unique index if not exists properties_one_primary
  on public.properties(customer_id) where is_primary;

-- 2. customers.tags — free-form relationship labels ("VIP", "landlord").
--    The column already existed in production but NO RUN file ever recorded it
--    (added out-of-band; found in review) — Customer V2 makes it load-bearing
--    on every create/edit, so the repo must be able to rebuild it. Idempotent.
alter table public.customers
  add column if not exists tags text[] not null default '{}';

-- 3. Measurement attribution, ONLY where truth is derivable. Of 31 unattributed
--    measurement rows, 30 are PROSPECT measurements (no customer_id at all —
--    the measure tool pointed at an arbitrary address). Attributing those would
--    invent facts, so they deliberately stay null; Pricing V2 Phase 0 owns
--    their semantics. Exactly one row belonged to a customer with exactly one
--    property — the only case where attribution is a fact, not a guess.
update public.measurements m
   set property_id = (select p.id from public.properties p where p.customer_id = m.customer_id)
 where m.property_id is null
   and m.customer_id is not null
   and (select count(*) from public.properties p where p.customer_id = m.customer_id) = 1;
