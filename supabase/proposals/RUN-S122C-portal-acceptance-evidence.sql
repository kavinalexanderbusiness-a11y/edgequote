-- ── S122C · The portal must be able to SEE acceptance evidence ──────────────
--
-- ⛔ CANDIDATE — NOT APPLIED, outside supabase/migrations so it cannot apply by
-- accident. S106 picks the version from the LIVE ledger.
--
-- ⚠️ THE APP IS CORRECT WITHOUT THIS. The portal currently fails closed: with no
-- evidence flag in the payload it never claims "you accepted", and it shows each
-- quote's CURRENT price. That is honest, and it is what stops the live defect
-- (EPS-2026-0152 told a customer "This is the price you accepted" over $1,400
-- with zero acceptance rows behind it and a $500 document in front of them).
--
-- What this restores is S121's consent SNAPSHOT for quotes that genuinely have
-- evidence: once the portal can prove an acceptance exists, an accepted quote
-- goes back to showing the figure the customer agreed to rather than a total the
-- owner may have moved since. Until then that protection is dormant — the app
-- prefers "less useful and true" over "more useful and unprovable".
--
-- ⭐ ONE BOOLEAN, derived. No new table, no new column, nothing stored: the
-- payload simply reports whether a row exists in quote_acceptances. Storing a
-- flag would be a second source of truth for consent, which is the exact defect
-- this whole lane exists to remove.

begin;

-- ── Widened by ANCHOR PATCH ─────────────────────────────────────────────────
-- ⭐⭐ get_portal_data's body is NEVER restated (the migration-audit lesson: an
-- older `create or replace` silently rolls back everyone else's widening). We
-- read the LIVE definition, add one field to the quote projection at one anchor,
-- and re-execute. The anchor must appear EXACTLY ONCE.
do $patch$
declare
  v_src text;
  v_old text;
  v_new text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data' and p.prokind = 'f';
  if v_src is null then
    raise exception 'get_portal_data not found — refusing to guess a body';
  end if;

  -- ⚠️⚠️ NORMALISE LINE ENDINGS FIRST. Postgres stores a body verbatim, so a
  -- definition applied from a CRLF checkout comes back with CRLF and an LF
  -- anchor matches ZERO times. This trap has now cost this lane twice.
  v_src := replace(v_src, E'\r\n', E'\n');

  -- ⚠️ Idempotency now keys on the SECOND field, not the first. A ledger that
  -- already carries `acceptance_kind` from the earlier one-field version of this
  -- patch must still receive the currentness bit, and keying on the kind would
  -- silently declare that database already done.
  if position('acceptance_is_current' in v_src) > 0 then
    raise notice 'already widened — nothing to do';
    return;
  end if;

  -- The quote projection's consent columns, which S122 added and S121 populated.
  v_old := 'qt.accepted_price, qt.deposit_type, qt.deposit_value,';
  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / nullif(length(v_old), 0);
  if coalesce(v_hits, 0) <> 1 then
    raise exception 'anchor found % times, expected exactly 1 — refusing to patch', coalesce(v_hits, 0);
  end if;

  -- ⛔ The KIND of the latest acceptance, and nothing else.
  --
  -- ⚠️ This began as a boolean `has_acceptance_evidence`, and that was wrong in
  -- a way only the next surface revealed: with a bare true/false the portal
  -- cannot tell the CUSTOMER's own acceptance from the OWNER's attestation, and
  -- would have told a customer "this is the price YOU accepted" about a phone
  -- call the business wrote down. S121 built those kinds to be different facts;
  -- a boolean collapses them at the last possible surface.
  --
  -- Still no actor, no timestamp, no amount, no note — the kind is the minimum
  -- that lets the portal choose an honest SENTENCE. A customer's own acceptance
  -- detail is theirs to be shown deliberately, never as a side effect of
  -- widening a list projection.
  -- ⭐⭐ AND WHETHER THAT ACCEPTANCE STILL MATCHES THIS DOCUMENT.
  --
  -- The kind alone was not enough, and the gap was found on a generated PDF: a
  -- quote accepted at $1,400 whose document has since been revised to $500
  -- printed "Quote Total $500.00" above a deposit derived from the $1,400
  -- snapshot. To stop presenting that figure the surface must know the acceptance
  -- is superseded — and the honest answer is the FINGERPRINT one.
  --
  -- ⛔ IT MUST BE THE CANONICAL FUNCTION, not a comparison invented here. The
  -- owner's screens ask `quote_acceptance_is_current`; the charge route asks
  -- `quote_acceptance_is_current`; so the portal asks it too. The first attempt
  -- used a TOTAL comparison on the client, which disagreed with the fingerprint
  -- on a class that is reachable and was already proven: an edit to `address`,
  -- `service_type`, `notes` or the deposit terms moves the fingerprint and leaves
  -- `total` untouched. Same quote, two documents, two answers — the exact defect
  -- class this lane exists to close.
  --
  -- ⭐ ONE BIT, and it ships in the SAME patch as the kind on purpose. The
  -- superseded-figure problem only exists once the snapshot is usable, and the
  -- snapshot only becomes usable when `acceptance_kind` is projected — so there
  -- is never a window where a surface can show a snapshot without also knowing
  -- whether it still stands. No actor, no amount, no timestamp, no note.
  --
  -- ⚠️ SAFE FOR AN ANONYMOUS CALLER: quote_acceptance_is_current returns false
  -- for an unknown quote and applies its tenant check only when auth.uid() is
  -- non-null, which it is not in the portal. It leaks nothing a token holder
  -- cannot already see about their own quote.
  v_new := v_old || E'\n'
        || '             (select qa.kind from public.quote_acceptances qa'
        || E'\n'
        || '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,'
        || E'\n'
        || '             public.quote_acceptance_is_current(qt.id) as acceptance_is_current,';

  v_src := replace(v_src, v_old, v_new);
  execute v_src;
end;
$patch$;

commit;
