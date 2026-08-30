-- ── S122 · Acceptance may not record consent to contradictory terms ──────────
--
-- ⛔ CANDIDATE — NOT APPLIED, and deliberately OUTSIDE supabase/migrations so it
-- cannot be applied by accident. S106 picks the real version from the LIVE
-- ledger at apply time (the custom-fields lesson), moves this into migrations/,
-- and runs the backfill BEFORE the gate can refuse anything.
--
-- WHY
-- S121 made the owner's Terms & Conditions load-bearing: the customer must see
-- and agree to them before a quote can be accepted, and quote_record_acceptance
-- snapshots the terms IN FORCE AT ACCEPTANCE into the evidence row. S122 then
-- measured production and found quotes configured to require 50% before
-- scheduling under terms that read "Payment due upon completion".
--
-- The app-side send gate stops a NEW contradictory document going out. It cannot
-- stop:
--   • an ALREADY-SENT contradictory quote being accepted, or
--   • terms edited AFTER a compatible quote was sent,
-- and it cannot stop either from a stale or direct client, because
-- portal_accept_quote is granted to `anon` and reachable through PostgREST. The
-- UI is not the boundary. This function is.
--
-- WHAT THIS ADDS
-- The database cannot read English, so it does not try. The APP classifies the
-- terms once (lib/payments/termsTimingConflict — the ONE classifier) and stores
-- a normalized, quote-INDEPENDENT verdict; this function performs a scalar
-- comparison. ⛔ No regex payment interpretation in SQL, ever — a second rule set
-- would drift from the first and the drift would be invisible.

begin;

-- ── 1 · The durable classification ──────────────────────────────────────────
-- The claim describes THE TERMS, not their fit with any one quote: it is stored
-- per tenant and reused for every quote, so a state meaning "compatible" would
-- be a category error (compatibility is a property of a terms×quote PAIR, and
-- would be wrong for the very next quote).
alter table public.business_settings
  add column if not exists terms_payment_claim text,
  add column if not exists terms_payment_claim_fingerprint text,
  add column if not exists terms_payment_claim_version integer;

comment on column public.business_settings.terms_payment_claim is
  'Normalized, quote-INDEPENDENT claim the terms make about WHEN money is due: no_claim | no_money_before_work | money_before_work | ambiguous. Written ONLY by the app''s canonical classifier (lib/payments/termsTimingConflict). NULL = never classified, treated as unclassified and fails closed at acceptance.';
comment on column public.business_settings.terms_payment_claim_fingerprint is
  'quote_terms_fingerprint() of the EXACT terms_text this claim was computed from. The claim is trusted only while this equals the live fingerprint — this is what un-trusts an old verdict after a post-send terms edit.';
comment on column public.business_settings.terms_payment_claim_version is
  'TERMS_CLASSIFIER_VERSION that produced the claim. Terms can stay byte-identical while our reading of them improves, which a fingerprint cannot see. An older version reads as unclassified.';

alter table public.business_settings
  drop constraint if exists business_settings_terms_payment_claim_check;
alter table public.business_settings
  add constraint business_settings_terms_payment_claim_check
  check (terms_payment_claim is null or terms_payment_claim in
         ('no_claim', 'no_money_before_work', 'money_before_work', 'ambiguous'));

-- ⛔ 'unclassified' is deliberately NOT storable. It is not a verdict the
-- classifier can reach — it is the DB's word for "the stored verdict cannot be
-- trusted", derived at READ time from a NULL claim, a fingerprint that no longer
-- matches the live terms, or an older classifier version.

-- ── 2 · Invalidation trigger (SECONDARY protection) ─────────────────────────
-- The fingerprint comparison at acceptance is the PRIMARY protection and is
-- mandatory. This trigger is belt-and-braces: it refuses to let an incoherent
-- verdict sit in the row at all, so a direct UPDATE of terms_text from any
-- client cannot leave a stale claim behind. An ATOMIC owner save carrying the
-- new terms AND their matching classification in the same statement passes
-- through untouched, so a normal Settings edit never creates a broken window.
create or replace function public.business_settings_invalidate_terms_claim()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if new.terms_payment_claim is not null
     and new.terms_payment_claim_fingerprint
         is distinct from md5(btrim(coalesce(new.terms_text, ''))) then
    new.terms_payment_claim := null;
    new.terms_payment_claim_fingerprint := null;
    new.terms_payment_claim_version := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_business_settings_invalidate_terms_claim on public.business_settings;
create trigger trg_business_settings_invalidate_terms_claim
  before insert or update on public.business_settings
  for each row execute function public.business_settings_invalidate_terms_claim();

-- ── 3 · THE GATE, by ANCHOR PATCH ───────────────────────────────────────────
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
