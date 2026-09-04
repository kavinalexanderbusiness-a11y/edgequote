-- ── S122E · The version RECORDED must be the version that was CHECKED ───────
--
-- ⛔ CANDIDATE — NOT APPLIED, outside supabase/migrations so it cannot apply by
-- accident. S106 picks the version from the LIVE ledger.
--
-- ⛔ APPLY AFTER RUN-S122D. This patch is inert on its own — no caller arms the
-- markers it reads until S122D does.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- An independent S121 review proved a race in RUN-S122D, and its consequence:
--
--   owner_confirm_current_acceptance computes the material fingerprint and
--   compares it to the version the owner confirmed. It then calls
--   quote_record_acceptance, which RECOMPUTES the fingerprint from scratch and
--   stores THAT. v_fp is never handed to the writer.
--
-- Between those two evaluations sit ~14 statements including an UPDATE of
-- public.quotes, and the only lock held is `select … from public.quotes … for
-- update` — ONE row, ONE relation. The fingerprint spans FOUR: quotes,
-- quote_services, quote_options, quote_addons. Three of them are read again,
-- unlocked, by the writer.
--
-- ⭐⭐⭐ THE HARM IS AN INVERSION, NOT A GAP. The RPC's job in that window is to
-- REFUSE (`fingerprint_mismatch`). Instead it stores the POST-change fingerprint,
-- so quote_acceptance_is_current() answers TRUE for a version the owner never
-- saw. Scope added concurrently — a service line, a price edit — is retroactively
-- blessed as accepted, and every downstream gate that asks that question
-- (scheduling, quote→invoice, the portal deposit charge) then treats it as
-- consented. Executed three ways: a concurrent INSERT, UPDATE and DELETE on
-- quote_services each recorded a DIFFERENT fingerprint than the one confirmed,
-- and each still returned ok:true.
--
-- ⚠️ THE CONCURRENT WRITER IS THE ORDINARY SAVE BUTTON. The quote editor replaces
-- a breakdown by DELETING every child row and re-inserting them, as separate
-- PostgREST requests and therefore separate committed transactions — its own
-- comment calls this "atomically-enough for a single owner". Two tabs, or a save
-- while a confirmation dialog is open elsewhere, and the window is a network
-- round-trip wide, against a human confirmation step. quote_services has no
-- DELETE trigger at all, and its path is not gated on status.
--
-- ── WHY NOT LOCK THE CHILD ROWS ─────────────────────────────────────────────
-- ⛔ Demonstrated not to work: `for update` takes ROW locks on rows that already
-- exist. It is not a predicate lock, so under READ COMMITTED it cannot stop a
-- phantom INSERT — and INSERT is precisely the editor's re-insert step. Locking
-- parent AND children is insufficient. SERIALIZABLE would catch phantoms but
-- turns the race into a retry the client must handle, and a lock protocol every
-- writer must honour reopens the moment one writer forgets. Freezing
-- quote_services the way quote_addons is frozen would forbid something the
-- product deliberately supports ("price corrections after approval go the way
-- they already do").
--
-- ── THE CONTRACT ────────────────────────────────────────────────────────────
-- ⭐⭐ One equality assertion over both evaluations, inside the same transaction
-- as the write. No locking, no isolation change, no cooperation from any other
-- writer: the check happens AFTER every read the transaction makes, so a child
-- change committing later cannot affect what was already stored — and such a
-- change correctly invalidates the acceptance through the existing
-- quote_acceptance_is_current path instead, which is the right ending.
--
-- ⭐ IT LIVES IN THE CANONICAL WRITER, so every caller inherits it rather than
-- re-deriving it. The portal path has the same two-evaluation shape and can arm
-- the same contract the day it carries an expectation.
--
-- ⛔⛔ AND IT CHANGES NO SIGNATURE AND NO GRANT. An added parameter — even one
-- with a DEFAULT — is a NEW function in Postgres, so `quote_record_acceptance`
-- would become ambiguous for its two existing in-database callers ("function is
-- not unique"), and removing the old one means DROP plus a full restatement of a
-- 120-line body: the exact migration-audit trap this lane keeps hitting. The
-- expectation therefore travels the way this codebase already carries markers
-- between database functions in one transaction — transaction-local GUCs set by
-- in-database code, unreachable from any PostgREST caller, exactly as
-- app.quote_consent_writer and app.quote_acceptance_kind already do.
--
-- ⭐ SINGLE-USE BY CONSTRUCTION: the writer CLEARS the markers as it consumes
-- them, so a second write in the same transaction cannot inherit a stale
-- expectation. Unset markers mean "no expectation declared" and the writer
-- behaves exactly as it does today — which is why this is inert until S122D arms
-- it, and why no existing caller changes behaviour.

begin;

-- ── Patched by ANCHOR PATCH ─────────────────────────────────────────────────
-- ⭐⭐ quote_record_acceptance's body is NEVER restated. We read the LIVE
-- definition, insert the assertion at one anchor, and re-execute. The anchor must
-- appear EXACTLY ONCE.
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

  -- ⚠️⚠️ NORMALISE LINE ENDINGS FIRST. Postgres stores a body verbatim, so a
  -- definition applied from a CRLF checkout comes back with CRLF and an LF anchor
  -- matches ZERO times. This trap has now cost this lane three times.
  v_src := replace(v_src, E'\r\n', E'\n');

  if position('app.quote_expected_fingerprint' in v_src) > 0 then
    raise notice 'already patched — nothing to do';
    return;
  end if;

  -- ⭐ A ONE-LINE anchor, deliberately: a multi-line anchor written in THIS file
  -- would carry this checkout's own line endings into the comparison, which is
  -- the same trap one level up. The tail of the single INSERT is unique.
  v_old := '  ) returning id into v_id;';
  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / nullif(length(v_old), 0);
  if coalesce(v_hits, 0) <> 1 then
    raise exception 'anchor found % times, expected exactly 1 — refusing to patch', coalesce(v_hits, 0);
  end if;

  -- Same reason: the inserted block is normalised before it is spliced in, so the
  -- patched body is LF throughout however this file was checked out.
  v_new := v_old || replace($ins$

  -- ⭐⭐⭐ S122E · THE VERSION RECORDED MUST BE THE VERSION THAT WAS CHECKED.
  -- A caller that has already validated a specific version against the person
  -- confirming it declares that version here. Between their check and the INSERT
  -- above, the fingerprint is evaluated a SECOND time from a fresh snapshot, over
  -- four tables of which only `quotes` was ever locked — so a concurrent
  -- child-row write turns a refusal into an authorisation.
  --
  -- ⛔ Read back what was STORED. Re-deriving the fingerprint here would take yet
  -- another snapshot and could agree with a document that neither the caller nor
  -- this INSERT ever saw.
  --
  -- ⭐ No expectation declared = no change in behaviour. Inert for every caller
  -- that does not arm it.
  declare
    v_expect_fp  text := nullif(btrim(coalesce(current_setting('app.quote_expected_fingerprint', true), '')), '');
    v_expect_amt text := nullif(btrim(coalesce(current_setting('app.quote_expected_amount', true), '')), '');
    v_stored_fp  text;
    v_stored_amt numeric(10,2);
  begin
    if v_expect_fp is not null or v_expect_amt is not null then
      -- ⭐ Consumed exactly once: cleared before the comparison, so a second write
      -- in this transaction cannot inherit a stale expectation.
      perform set_config('app.quote_expected_fingerprint', '', true);
      perform set_config('app.quote_expected_amount', '', true);
      select a.document_fingerprint, a.accepted_amount
        into v_stored_fp, v_stored_amt
        from public.quote_acceptances a where a.id = v_id;
      if v_expect_fp is not null and v_stored_fp is distinct from v_expect_fp then
        raise exception 'this quote changed while it was being confirmed — the version that would have been recorded is not the version that was checked, so nothing was saved'
          using errcode = '40001';
      end if;
      if v_expect_amt is not null
         and abs(coalesce(v_stored_amt, 0) - v_expect_amt::numeric) > 0.005 then
        raise exception 'this quote changed while it was being confirmed — the amount that would have been recorded is not the amount that was confirmed, so nothing was saved'
          using errcode = '40001';
      end if;
    end if;
  end;
$ins$, E'\r\n', E'\n');

  v_src := replace(v_src, v_old, v_new);
  execute v_src;
end;
$patch$;

comment on function public.quote_record_acceptance(uuid, text, text, uuid, text, text, text, boolean) is
  'THE canonical evidence writer — every acceptance door composes it, so every S121 evidence rule and the S122 terms-contradiction gate apply on all of them. S122E: a caller that has already validated a specific version may declare it in the transaction-local markers app.quote_expected_fingerprint / app.quote_expected_amount; the writer then asserts that the fingerprint and the amount it actually STORED equal the declared ones, and raises serialization_failure otherwise, so a concurrent child-row write cannot convert a refusal into an authorisation. The markers are consumed once and are unreachable from any PostgREST caller.';

commit;
