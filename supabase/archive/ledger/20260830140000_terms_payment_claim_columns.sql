-- ── S122 · STAGE A — the durable terms classification (columns only) ─────────
--
-- ⛔ CANDIDATE — NOT APPLIED, and deliberately OUTSIDE supabase/migrations so it
-- cannot apply by accident. S106 picks the real version from the LIVE ledger at
-- apply time (the custom-fields lesson).
--
-- ⛔⛔ APPLY ORDER IS LOAD-BEARING:
--        Stage A  (THIS FILE — columns + constraint + invalidation trigger)
--     →  BACKFILL (scripts/backfill-terms-claim.ts, report first, then --apply)
--     →  Stage B  (RUN-S122B-acceptance-terms-gate.sql — the refusal)
--
-- ⭐ Stage A is ADDITIVE AND INERT. Three nullable columns and a trigger that
-- only ever CLEARS an incoherent verdict; nothing reads them yet, so applying it
-- changes no behaviour and it is safe to sit on. Stage B is the only part that
-- can refuse an acceptance, and it fails closed on an unclassified tenant BY
-- DESIGN — so applying B before the backfill would make every deposit-gated
-- quote under terms un-acceptable, an outage with a correct-looking cause.
-- Two files is what makes that ordering impossible to get wrong by accident
-- rather than merely documented in a comment nobody re-reads.
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

commit;
