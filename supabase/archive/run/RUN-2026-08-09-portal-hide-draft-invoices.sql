-- ── Portal privacy: a DRAFT invoice must never leave the database ────────────
-- 2026-08-09
--
-- PRODUCTION DATA EXPOSURE. get_portal_data selected the customer's invoices with
-- NO status filter, so a draft — the owner's unfinished, unsent, still-being-edited
-- bill — was serialized into the JSON the customer's browser receives. The portal
-- did not render it (buildDocItems filters `status !== 'draft'`), so nothing looked
-- wrong, but the row was fully readable in devtools: number, amount, line items,
-- notes. Verified live: token peter-dunham-467B385U returned 5 invoices, the UI
-- showed 4, and INV-0060 (draft) was the fifth.
--
-- A client-side filter is a rendering decision, never a privacy boundary. This
-- moves the boundary to the only place that can enforce it.
--
-- THE RULE — exactly one status is private, and this function already says so
-- about quotes, one line above:
--     from public.quotes qt where qt.customer_id = v_customer and qt.status <> 'draft'
-- Invoice statuses are pinned identically by the DB CHECK constraint
-- (invoices_status_check) and src/types/index.ts:636:
--     draft | unpaid | sent | partial | paid | overpaid | cancelled
-- `draft` is the owner's private work. Every other status is a bill the customer is
-- entitled to see — including `cancelled`, which they must still be able to read so
-- a withdrawn charge is explainable rather than vanishing. So the change is one
-- predicate, mirroring the quotes idiom exactly. Paid / unpaid / partial / overpaid
-- behaviour is untouched, and NO new field is exposed.
--
-- ⚠️  get_portal_data has exactly ONE definition in this repo —
-- supabase/CANONICAL-get_portal_data.sql (INF-2 collapsed the nine that used to
-- exist; the rest are tombstones). That file is a SNAPSHOT of a live object, so it
-- can lag production, and it is applied LAST on a reset — meaning a stale copy wins
-- and silently reverts. `npm run verify:portal-canonical` now fails the build on
-- exactly that drift. So this migration does NOT restate the body.
-- It reads the live definition, rewrites the ONE invoice FROM-clause, and re-executes
-- it — every other byte is carried across untouched, by construction. If the anchor
-- is ever absent or ambiguous it raises instead of guessing.

do $patch$
declare
  src  text;
  out_ text;
  hits int;
  anchor constant text := 'from public.invoices where customer_id = v_customer)';
  fixed  constant text := 'from public.invoices where customer_id = v_customer and status <> ''draft'')';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data';

  if src is null then
    raise exception 'get_portal_data not found — refusing to guess';
  end if;

  -- Already patched? Then this is a re-run: succeed without touching anything.
  if position(fixed in src) > 0 then
    raise notice 'get_portal_data already filters draft invoices — no change';
    return;
  end if;

  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'expected exactly 1 invoice FROM-clause, found % — refusing to patch blind', hits;
  end if;

  out_ := replace(src, anchor, fixed);
  execute out_;
  raise notice 'get_portal_data patched: invoices now exclude draft';
end
$patch$;

-- Proof, in the same transaction: the draft is gone and nothing else moved.
do $verify$
declare
  leaked int;
begin
  select count(*) into leaked
    from public.customer_portal_tokens t
    cross join lateral (select public.get_portal_data(t.token)::jsonb as d) x
    cross join lateral jsonb_array_elements(x.d -> 'invoices') e
   where not t.revoked and e ->> 'status' = 'draft';
  if leaked > 0 then
    raise exception 'still leaking % draft invoice row(s) across live portal tokens', leaked;
  end if;
  raise notice 'verified: 0 draft invoices reachable through any live portal token';
end
$verify$;
