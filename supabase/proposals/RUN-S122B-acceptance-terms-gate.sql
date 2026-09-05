-- ── S122 · STAGE B — the acceptance gate itself ─────────────────────────────
--
-- ⛔ CANDIDATE — NOT APPLIED. Lives outside supabase/migrations so it cannot
-- apply by accident. S106 picks the real version from the LIVE ledger.
--
-- ⛔⛔ APPLY ORDER IS LOAD-BEARING:
--        Stage A  (columns + constraint + invalidation trigger)
--     →  BACKFILL (scripts/backfill-terms-claim.ts --apply)
--     →  Stage B  (THIS FILE)
--
-- Stage B is the only part that can REFUSE anything, and it fails closed on an
-- unclassified tenant BY DESIGN. Applying it before the backfill would therefore
-- make every deposit-gated quote under terms un-acceptable until someone noticed
-- — a self-inflicted outage with a correct-looking cause. Splitting the stages
-- is what makes that ordering impossible to get wrong by accident rather than
-- merely documented.
--
-- Stage A is additive and inert on its own: three nullable columns and a trigger
-- that only ever CLEARS an incoherent verdict. It changes no behaviour, so it is
-- safe to apply and sit on.

begin;

-- ── THE GATE, by ANCHOR PATCH ────────────────────────────────────────────
-- ⭐⭐ The body is NOT restated. quote_record_acceptance is shared ground — S121
-- built its evidence contract and S114 landed beside it — and pasting a
-- remembered body over either lane is exactly how a landed feature silently
-- reverts (the migration-audit lesson). We read the LIVE definition, insert one
-- block at one anchor, and re-execute. The anchor must appear EXACTLY ONCE.
do $patch$
declare
  v_src text;
  v_old text;
  v_new text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'quote_record_acceptance' and p.prokind = 'f';
  if v_src is null then
    raise exception 'quote_record_acceptance not found — refusing to guess a body';
  end if;

  -- ⚠️⚠️ NORMALISE LINE ENDINGS FIRST. Postgres stores a function body verbatim,
  -- so a definition applied from a CRLF checkout comes back from
  -- pg_get_functiondef with CRLF — and an anchor written with LF then matches
  -- ZERO times. The guard caught it (that is what it is for), but a patch that
  -- only worked on one developer's checkout would have been worse than useless.
  -- Normalising once makes the anchor hold whichever way the body was stored;
  -- the re-emitted function is LF-only, which Postgres treats identically.
  v_src := replace(v_src, E'\r\n', E'\n');

  -- The existing terms-acknowledgement refusal: the last gate before the
  -- evidence row is built, and the only place that already knows terms are in
  -- force. Ours belongs immediately after it.
  v_old := 'if v_terms_required and not coalesce(p_terms_ack, false) then'
        || E'\n    raise exception ''the quoted scope and terms must be acknowledged before acceptance can be recorded'''
        || E'\n      using errcode = ''check_violation'';'
        || E'\n  end if;';

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / nullif(length(v_old), 0);
  if coalesce(v_hits, 0) <> 1 then
    raise exception 'anchor found % times, expected exactly 1 — refusing to patch', coalesce(v_hits, 0);
  end if;

  if position('S122 · TERMS MAY NOT CONTRADICT' in v_src) > 0 then
    raise notice 'gate already present — nothing to do';
    return;
  end if;

  v_new := v_old || E'\n'
|| E'\n  -- ⭐⭐ S122 · TERMS MAY NOT CONTRADICT THE QUOTE''S CONFIGURED PAYMENT TIMING.'
|| E'\n  -- Reached by EVERY door that records consent (portal_accept_quote for the'
|| E'\n  -- customer, owner_record_customer_acceptance for owner-on-behalf), which is'
|| E'\n  -- why the gate lives here and not in either caller.'
|| E'\n  -- ⛔ owner_override_quote_status never reaches this function and is therefore'
|| E'\n  -- untouched: an administrative status correction still records NO evidence,'
|| E'\n  -- exactly as S121 intended.'
|| E'\n  if v_terms_required then'
|| E'\n    declare'
|| E'\n      v_claim text; v_claim_fp text; v_claim_ver integer;'
|| E'\n      v_live_fp text; v_requires_deposit boolean;'
|| E'\n    begin'
|| E'\n      select b.terms_payment_claim, b.terms_payment_claim_fingerprint, b.terms_payment_claim_version'
|| E'\n        into v_claim, v_claim_fp, v_claim_ver'
|| E'\n        from public.business_settings b where b.user_id = v_q.user_id limit 1;'
|| E'\n      v_live_fp := public.quote_terms_fingerprint(v_q.user_id);'
|| E'\n'
|| E'\n      -- FAIL CLOSED on anything but a trustworthy verdict for THESE EXACT terms.'
|| E'\n      -- The fingerprint is what un-trusts an old classification after a terms'
|| E'\n      -- edit; the version catches terms that never changed while our reading of'
|| E'\n      -- them did. ⛔ Never trust "a trigger ran last time".'
|| E'\n      if v_claim is null'
|| E'\n         or v_claim_fp is distinct from v_live_fp'
|| E'\n         or coalesce(v_claim_ver, 0) <> 1'
|| E'\n         or v_claim = ''ambiguous'' then'
|| E'\n        raise exception ''these terms have not been reviewed against this quote''''s payment schedule — the business needs to update the quote or its terms before this can be accepted'''
|| E'\n          using errcode = ''check_violation'';'
|| E'\n      end if;'
|| E'\n'
|| E'\n      -- Does this quote actually ask for money before the work? Derived from'
|| E'\n      -- v_amount, the authorized value this function already computed, so a'
|| E'\n      -- no-charge quote (S114) can never be read as requiring a deposit.'
|| E'\n      v_requires_deposit := v_q.deposit_type is not null and coalesce(v_amount, 0) > 0;'
|| E'\n'
|| E'\n      -- BOTH directions. Half a detector is how this gate would have shipped.'
|| E'\n      if v_requires_deposit and v_claim = ''no_money_before_work'' then'
|| E'\n        raise exception ''this quote requires a deposit before scheduling, but the terms in force tell the customer no money is due until the work is done — the business needs to update the quote or its terms'''
|| E'\n          using errcode = ''check_violation'';'
|| E'\n      end if;'
|| E'\n      if not v_requires_deposit and v_claim = ''money_before_work'' then'
|| E'\n        raise exception ''this quote asks for no deposit, but the terms in force tell the customer a deposit is required before the work starts — the business needs to update the quote or its terms'''
|| E'\n          using errcode = ''check_violation'';'
|| E'\n      end if;'
|| E'\n    end;'
|| E'\n  end if;';

  v_src := replace(v_src, v_old, v_new);
  execute v_src;
end;
$patch$;

commit;