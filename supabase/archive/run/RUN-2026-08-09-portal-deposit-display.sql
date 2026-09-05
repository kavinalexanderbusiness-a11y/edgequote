-- ── Portal: the deposit request reaches the customer's screen ────────────────
-- 2026-08-09
--
-- Deposits landed (RUN-2026-08-09-invoice-deposit-request.sql) as a request
-- stored ON the invoice, and BOTH charge routes already collect through
-- depositChargeAmount — the portal's Pay button charges the $1,500 deposit, not
-- the $3,000 total. But get_portal_data's invoice projection predates deposits,
-- so the portal cannot SEE the request: the row still displays "$3,000 due" and
-- the button quotes the full balance while Stripe (correctly) asks for $1,500.
-- The deposit_request message even promises "the portal link shows the full
-- invoice (total, deposit paid, what's left)" — a promise the payload cannot
-- keep without these two columns. Display and charge must read the same truth.
--
-- The columns are exactly the two the deposit engine stores, and they are the
-- customer's OWN information: deposit_amount is the figure the owner asks THEM
-- for (the message texts it to them verbatim), on an invoice they can already
-- see in full. A request saved but not yet sent (deposit_requested_at null) is
-- exposed too, deliberately: depositChargeAmount already charges by it, so
-- hiding it would recreate the exact display-vs-charge disagreement this fixes.
--
-- ⚠️  get_portal_data is a FROZEN surface: the repo's definitions of it are all
-- stale and only the LIVE definition is authoritative (migration-audit +
-- prod-schema-exceeds-main). So — same discipline as
-- RUN-2026-08-09-portal-hide-draft-invoices.sql, whose anchor this patch is
-- careful to leave intact so the two apply cleanly in EITHER order — this does
-- NOT restate the body. It reads the live definition, widens the ONE invoice
-- column list, and re-executes it; every other byte is carried across untouched,
-- by construction. If the anchor is absent or ambiguous it raises instead of
-- guessing.

do $patch$
declare
  src  text;
  out_ text;
  hits int;
  -- The invoice projection's column list, ending at its FROM keyword. The
  -- draft-invoices patch edits the WHERE clause after this — disjoint text, so
  -- neither patch can disturb the other's anchor.
  anchor constant text := 'created_at, discount_type, discount_value from public.invoices';
  fixed  constant text := 'created_at, discount_type, discount_value, deposit_amount, deposit_requested_at from public.invoices';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data';

  if src is null then
    raise exception 'get_portal_data not found — refusing to guess';
  end if;

  -- Already patched? Then this is a re-run: succeed without touching anything.
  if position('deposit_requested_at' in src) > 0 then
    raise notice 'get_portal_data already exposes the deposit request — no change';
    return;
  end if;

  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'expected exactly 1 invoice column list, found % — refusing to patch blind', hits;
  end if;

  out_ := replace(src, anchor, fixed);
  execute out_;
  raise notice 'get_portal_data patched: invoices now carry deposit_amount + deposit_requested_at';
end
$patch$;

-- Proof, in the same transaction: every invoice element any live token can reach
-- now carries the deposit keys (null when no deposit is asked — the key must
-- still be present, or the model can't tell "no deposit" from "old payload").
do $verify$
declare
  missing int;
begin
  select count(*) into missing
    from public.customer_portal_tokens t
    cross join lateral (select public.get_portal_data(t.token)::jsonb as d) x
    cross join lateral jsonb_array_elements(x.d -> 'invoices') e
   where not t.revoked
     and not (jsonb_exists(e, 'deposit_amount') and jsonb_exists(e, 'deposit_requested_at'));
  if missing > 0 then
    raise exception '% invoice row(s) reachable through live tokens are missing the deposit keys', missing;
  end if;
  raise notice 'verified: every invoice element across live portal tokens carries the deposit keys';
end
$verify$;
