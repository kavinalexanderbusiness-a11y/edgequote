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

  if position('acceptance_kind' in v_src) > 0 then
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
  v_new := v_old || E'\n'
        || '             (select qa.kind from public.quote_acceptances qa'
        || E'\n'
        || '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,';

  v_src := replace(v_src, v_old, v_new);
  execute v_src;
end;
$patch$;

commit;
