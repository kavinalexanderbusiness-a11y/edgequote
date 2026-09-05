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
  v_kind_n int;
  v_cur_n int;
  -- ⭐ The two projected lines, named once so the baseline splice and the upgrade
  -- splice cannot drift apart. Both paths must produce the SAME final body.
  c_kind constant text :=
       '             (select qa.kind from public.quote_acceptances qa'
    || E'\n'
    || '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,';
  c_cur constant text :=
       '             public.quote_acceptance_is_current(qt.id) as acceptance_is_current,';
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

  -- Count both projections ONCE, up front: every branch below reasons about them.
  v_kind_n := (length(v_src) - length(replace(v_src, ') as acceptance_kind,', ''))) / length(') as acceptance_kind,');
  v_cur_n  := (length(v_src) - length(replace(v_src, ' as acceptance_is_current,', ''))) / length(' as acceptance_is_current,');

  -- ⚠️ Idempotency keys on the SECOND field, not the first. A ledger that already
  -- carries `acceptance_kind` from the earlier one-field version of this patch
  -- must still receive the currentness bit, and keying on the kind would silently
  -- declare that database already done.
  if v_cur_n > 0 then
    if v_cur_n <> 1 or v_kind_n <> 1 then
      raise exception 'get_portal_data already carries % kind and % currentness projections — expected exactly 1 of each, refusing to touch a body this patch did not produce',
        v_kind_n, v_cur_n;
    end if;
    raise notice 'already widened — nothing to do';
    return;
  end if;

  -- ⭐⭐ BRANCH ON WHAT IS ACTUALLY THERE, because there are TWO starting points
  -- and they need different anchors.
  --
  -- An earlier version of this patch projected the KIND alone. A database that
  -- took it is not baseline any more, and splicing at the baseline anchor would
  -- re-insert a projection it already has: measured, `kind=2, is_current=1`.
  -- Postgres ACCEPTS a duplicate output column and the emitted JSON is still
  -- correct — so this is not a payload defect — but it leaves two databases with
  -- different function bodies for no functional reason, and it strands them for
  -- the NEXT anchor patch, every one of which refuses unless its anchor matches
  -- exactly once.
  --
  -- ⭐ Both paths must end at the SAME body. That is why the kind lines below are
  -- byte-identical to the ones the earlier version emitted, and why the upgrade
  -- path appends the currentness line directly after the kind projection rather
  -- than rebuilding it.
  if v_kind_n > 0 then
    if v_kind_n <> 1 then
      raise exception 'get_portal_data carries % acceptance_kind projections, expected exactly 1 — refusing to patch a malformed body', v_kind_n;
    end if;
    -- UPGRADE PATH: anchor on the kind projection that is already there.
    v_old := ') as acceptance_kind,';
  else
    -- BASELINE PATH: the quote projection's consent columns, which S122 added
    -- and S121 populated.
    v_old := 'qt.accepted_price, qt.deposit_type, qt.deposit_value,';
  end if;
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
  -- The upgrade path appends ONLY the currentness line, after the kind projection
  -- that is already present. The baseline path adds both.
  if v_kind_n > 0 then
    v_new := v_old || E'\n' || c_cur;
  else
    v_new := v_old || E'\n' || c_kind || E'\n' || c_cur;
  end if;

  v_src := replace(v_src, v_old, v_new);

  -- ⛔⛔ POST-ASSERT BEFORE EXECUTING, not after. Whatever path got us here, the
  -- body about to be installed must carry EXACTLY ONE of each projection — that
  -- is the property the next anchor patch in this lane will depend on, and the
  -- only way both paths can be said to converge on the same body.
  v_kind_n := (length(v_src) - length(replace(v_src, ') as acceptance_kind,', ''))) / length(') as acceptance_kind,');
  v_cur_n  := (length(v_src) - length(replace(v_src, ' as acceptance_is_current,', ''))) / length(' as acceptance_is_current,');
  if v_kind_n <> 1 or v_cur_n <> 1 then
    raise exception 'refusing to install a body with % kind and % currentness projections — expected exactly 1 of each',
      v_kind_n, v_cur_n;
  end if;

  execute v_src;
end;
$patch$;

commit;
