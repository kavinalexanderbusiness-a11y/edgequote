#!/usr/bin/env bash
# ── Mutation test for the quote-number guards ────────────────────────────────
#
# An assertion that cannot fail is decoration. This breaks each load-bearing rule
# on purpose and requires the named check to go RED.
#
#   bash scripts/mutate-quote-number.sh
#
# ⚠️⚠️ COMMIT FIRST. Files are edited in place and restored from a backup in a
# trap, so an interrupt cannot leave a mutation behind — but uncommitted work in
# these files is still what is most likely to be lost.
#
# ⭐ THREE SPEEDS, because the guards are not interchangeable and pretending they
# are is how a rule ends up defended by nothing:
#
#   static — caught by the STATIC half of verify:quote-number-integrity. PGlite is
#            hidden so the behavioural half cannot run. Seconds.
#   full   — needs SQL to actually execute. verify:quote-number-integrity with
#            PGlite present. A minute or two each.
#   pg     — needs REAL PostgreSQL with REAL independent connections, because the
#            rule is about contention, grants, or a DELETE (PGlite can do none of
#            those on this schema). Runs verify:quote-number-concurrency against a
#            disposable server. Under a minute each.
#
# Which speed a mutation needs is stated, not guessed — mutation 6 below survived
# as `static` against a guard that was working perfectly, because the claim it
# makes is behavioural and the static check only asserted that a statement
# existed.

set -uo pipefail
cd "$(dirname "$0")/.."

PROPOSAL="supabase/proposals/quote_number_integrity_v1.sql"
UTILS="src/lib/utils.ts"
SEAM="src/lib/quoteNumber.ts"
NEWQ="src/app/dashboard/quotes/new/page.tsx"
GUARD="scripts/verify-quote-number-integrity.ts"
GUARD_PG="scripts/verify-quote-number-concurrency.ts"

BACKUP_DIR="$(mktemp -d)"

# ⚠️⚠️ THE BACKUP SET IS DERIVED, NOT HAND-KEPT — because a hand-kept one already
# leaked a mutation into the working tree. A mutation was added against
# src/app/dashboard/quotes/page.tsx, that file was not in the list, and `restore`
# therefore skipped it: the mutation SURVIVED THE SUITE and sat in the tree
# afterwards, where the next run saw it as the new baseline and reported a
# HARNESS BUG for an anchor that was perfectly good. Committing first meant
# nothing was lost, but a test harness that edits files must not be able to
# forget one.
#
# ⭐ Now every file is backed up the first time a mutation names it, and restore
# walks what was actually touched. Adding a mutation against a new file needs no
# bookkeeping at all.
declare -A BACKUP_OF
TOUCHED=()

ensure_backup() {
  local f="$1"
  [ -n "${BACKUP_OF[$f]:-}" ] && return 0
  local key; key="$(printf '%s' "$f" | tr '/\\:' '___')"
  cp "$f" "$BACKUP_DIR/$key"
  BACKUP_OF["$f"]="$BACKUP_DIR/$key"
  TOUCHED+=("$f")
  return 0
}

PGLITE_DIR="node_modules/@electric-sql/pglite"
PGLITE_HIDDEN="node_modules/@electric-sql/.pglite-hidden-by-mutation-test"
hide_pglite()   { [ -d "$PGLITE_DIR" ] && mv "$PGLITE_DIR" "$PGLITE_HIDDEN"; return 0; }
unhide_pglite() { [ -d "$PGLITE_HIDDEN" ] && mv "$PGLITE_HIDDEN" "$PGLITE_DIR"; return 0; }

restore() {
  local f
  for f in ${TOUCHED[@]+"${TOUCHED[@]}"}; do
    cp "${BACKUP_OF[$f]}" "$f"
  done
}
cleanup() { restore; unhide_pglite; rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT INT TERM

pass=0; fail=0

# WARNING: 2>&1, NOT 2>/dev/null — check() writes failures with console.error, so
# discarding stderr throws away every failure marker and reports "0 caught" for a
# harness that was working perfectly.
run_guard()    { npx tsx "$GUARD" 2>&1; }
run_guard_pg() { npx tsx "$GUARD_PG" 2>&1; }

# mutate <mode: static|full|pg> <name> <expected-check-substring> <file> <perl-expr>
#
# ⚠️⚠️ A MUTATION THAT NEVER APPLIED LOOKS EXACTLY LIKE A GUARD THAT CAUGHT
# NOTHING — both leave the suite green, and the harness would report SURVIVED for
# a rule that is perfectly well defended. So the file is checksummed and "no
# change" is reported as a HARNESS BUG, loudly and separately.
# ⚠️ A changed file is still not necessarily the RIGHT change: an unescaped | or
# ( in a perl expression can match something unintended, change bytes, satisfy
# the checksum and mutate nothing that matters. Escape them.
#
# ⚠️ -A3, NOT a bare grep for '✗'. A failed check prints its NAME on the ✗ line
# and its DETAIL on the next one or two, and several rules here are only
# distinguishable by the detail — most importantly a migration that REFUSES to
# apply, where the ✗ line just says "applied …" and the reason is underneath.
mutate() {
  local mode="$1" name="$2" expect="$3" file="$4" expr="$5"
  restore
  ensure_backup "$file"      # ⭐ after restore, so the copy taken is a clean one
  if [ "$mode" = "static" ]; then hide_pglite; else unhide_pglite; fi
  local before after out
  before=$(cksum < "$file")
  perl -0pi -e "$expr" "$file"
  after=$(cksum < "$file")
  if [ "$before" = "$after" ]; then
    echo "  ⚠ HARNESS BUG: $name"
    echo "      the mutation did not change $file — its anchor no longer matches."
    fail=$((fail+1)); return
  fi
  # ⭐ MUTATE_DRY=1 · anchors only. Every mutation here is anchored to exact text
  # in a file other sessions also edit, so anchor rot is the failure this suite
  # hits most often — and discovering it 40 minutes into a full run, one mutation
  # at a time, is the slowest possible way to learn it. A dry pass answers "do all
  # 46 anchors still apply?" in seconds. It proves nothing about the GUARDS, so it
  # is never a substitute for the real run.
  if [ "${MUTATE_DRY:-}" = "1" ]; then
    echo "  ✓ anchor applies: $name  [$mode, dry]"
    pass=$((pass+1)); return
  fi
  if [ "$mode" = "pg" ]; then out=$(run_guard_pg); else out=$(run_guard); fi
  if ! printf '%s' "$out" | grep -A3 '✗' | grep -qF "$expect"; then
    echo "  ✗ SURVIVED: $name"
    echo "      nothing went red — expected a failure naming: $expect"
    fail=$((fail+1))
  else
    echo "  ✓ caught: $name  [$mode]"
    pass=$((pass+1))
  fi
}

echo ""
echo "══ mutations ═══════════════════════════════════════════════════════════"
echo ""
echo "  ── the barrier: history, and the future ──"

# ⭐⭐ 1 · THE CLAIM REGISTRY REMOVED ENTIRELY. This is the rule the whole
# revision exists for: without it only the partial index defends, and the partial
# index cannot see a pre-cutover row.
# ⚠️ This mutation SURVIVED on its first run and the guard was wrong, not the
# mutation: the existence check matched `public.document_number_claims` as a
# PREFIX, so a table renamed to `…_claims_unused` still satisfied it. The check
# now ends the identifier.
mutate static "the claim registry removed" \
  "a claim registry exists, keyed on (tenant, kind, number)" \
  "$PROPOSAL" \
  's/create table if not exists public\.document_number_claims/create table if not exists public.document_number_claims_unused/'

# ⭐⭐ 2 · HISTORY NOT SEEDED. The registry exists but never learns what the tenant
# already used, so a historical number is free again. ⭐ The migration's OWN
# apply-time assertion is what should stop this, and that is what this mutation
# measures — the guard never gets as far as the reuse test, which is correct.
mutate full "history left out of the claim registry" \
  "are not in the claim registry" \
  "$PROPOSAL" \
  's/   where q\.quote_number is not null\n  on conflict \(user_id, kind, number\) do nothing;/   where q.quote_number is not null and q.created_at > now()\n  on conflict (user_id, kind, number) do nothing;/'

# ⭐⭐ 2b · AND THE SAME HOLE WITH THAT ASSERTION SILENCED, so the migration
# applies and the reuse test itself has to catch it. Without this pair, mutation 2
# alone would leave "can a historical number be reused" defended by an assertion
# and nothing else.
mutate full "history unclaimed AND the apply-time assertion silenced" \
  "a NEW quote cannot reuse a PRE-CUTOVER historical number" \
  "$PROPOSAL" \
  's/   where q\.quote_number is not null\n  on conflict \(user_id, kind, number\) do nothing;/   where q.quote_number is not null and q.created_at > now()\n  on conflict (user_id, kind, number) do nothing;/; s/raise exception .quote_number_integrity: % existing quote\(s\) are not in the claim registry — history is not protected., v_unclaimed;/raise notice '"'"'silenced'"'"';/'

# 3 · seeded only from WELL-FORMED numbers, so the malformed legacy pair is
#     reissuable — the exact hole a counter-only design leaves open, since no
#     year-scoped counter can describe EPS-0002.
#     ⚠️ Length, not a regex: a regex here has to survive bash, perl and SQL
#     quoting, and the one that does not survive mutates nothing while looking
#     like it worked. EPS-0002 is 8 characters; EPS-2026-0008 is 13.
#     ⚠️ THE EXPECTATION NAMES THE SEED'S CHECK, NOT THE TRIGGER'S. This mutation
#     first survived against "a malformed legacy number is protected too", because
#     that check writes its number AFTER the proposal is applied — so the TRIGGER
#     claims it and breaking the SEED changes nothing. The guard now tests a
#     malformed number written BEFORE the cutover as well, and this points there.
mutate full "malformed legacy numbers left unclaimed" \
  "a malformed number that predates the cutover is claimed by the SEED" \
  "$PROPOSAL" \
  's/   where q\.quote_number is not null\n  on conflict \(user_id, kind, number\) do nothing;/   where q.quote_number is not null and length(q.quote_number) > 9\n  on conflict (user_id, kind, number) do nothing;/; s/raise exception .quote_number_integrity: % existing quote\(s\) are not in the claim registry — history is not protected., v_unclaimed;/raise notice '"'"'silenced'"'"';/'

# 4 · the claim trigger never created — the registry is seeded and then ignored.
#     ⭐ Again the apply-time assertion is what fires, and that is the point:
#     a migration that installs no trigger must not report success.
mutate full "the claim trigger never installed" \
  "claim trigger(s) missing" \
  "$PROPOSAL" \
  's/  create trigger quotes_claim_document_number\n    before insert or update of quote_number on public\.quotes\n    for each row execute function public\.claim_document_number\(\);/  perform 1;/'

# 5 · ⭐ THE BACKDATING ATTACK. Drop the registry's protection and keep only the
#     partial index: a caller that supplies an old created_at lands outside the
#     predicate and is written. This is precisely why the index alone was not
#     enough, so it gets its own mutation.
#     ⚠️ RE-ANCHORED when claims became permanent: the trigger no longer refuses
#     via an exception block around the INSERT, it refuses via the raise that
#     follows the holder lookup. The old anchor rotted silently and the dry pass
#     is what surfaced it.
mutate full "only the created_at-predicated index defends" \
  "a stale or manipulated caller cannot backdate its way around it" \
  "$PROPOSAL" \
  "s/      raise exception 'quote number % has already been used by this business', new\.quote_number\n        using errcode = '23505',\n              hint = '[^']*';/      raise notice 'barrier disabled';/"

# 6 · the UNIQUE index downgraded — defence in depth, still load-bearing.
mutate static "the UNIQUE index downgraded to a plain index" \
  "a UNIQUE index protects" \
  "$PROPOSAL" \
  's/create unique index quotes_user_qnum_new_unique/create index quotes_user_qnum_new_unique/'

echo ""
echo "  ── the cutover has no window ──"

# 7 · the table lock removed, so writers are not quiesced while the registry is
#     seeded — a quote written mid-seed is claimed by nothing.
mutate static "the cutover lock removed" \
  "the cutover takes a table lock before it seeds" \
  "$PROPOSAL" \
  's/  lock table public\.quotes in share row exclusive mode;/  perform 1;/'

# 8 · ⭐ THE ORIGINAL DEFECT, PUT BACK. A hand-edited literal cutoff is either
#     unindexable (before apply) or leaves a window (after apply).
mutate static "a hand-written literal cutoff restored" \
  "the cutoff is measured inside the transaction" \
  "$PROPOSAL" \
  "s/  v_cutoff := clock_timestamp\(\);/  v_cutoff := timestamptz '2026-08-30 00:00:00+00';/"

# 9 · the apply-time assertion removed, so a half-applied migration reports success
mutate static "the migration allowed to finish half-applied" \
  "the migration REFUSES to finish if any quote is unclaimed" \
  "$PROPOSAL" \
  "s/raise exception 'quote_number_integrity: % existing quote\(s\) are not in the claim registry — history is not protected', v_unclaimed;/raise notice 'ignored';/"

echo ""
echo "  ── the allocator's contract ──"

# 10 · ⭐ THE xmax REPLACEMENT, BOTH BRANCHES. Shift the insert branch's seed so
#      the FIRST allocation no longer claims 1.
mutate full "the insert branch no longer claims 0001" \
  "the INSERT branch (first ever allocation) claims 0001" \
  "$PROPOSAL" \
  "s/       values \(v_user, 'quote', v_prefix, v_year, 2\)/       values (v_user, 'quote', v_prefix, v_year, 3)/"

# 11 · and the update branch's arithmetic
mutate full "the update branch returns the wrong claimed value" \
  "the UPDATE branch (every allocation after) claims 0002" \
  "$PROPOSAL" \
  's/    returning next_value - 1 into v_value;/    returning next_value into v_value;/'

# 12 · xmax smuggled back in
mutate static "numbering made to depend on xmax again" \
  "the allocator returns next_value - 1, not an xmax branch" \
  "$PROPOSAL" \
  's/    returning next_value - 1 into v_value;/    returning case when xmax = 0 then 1 else next_value - 1 end into v_value;/'

# 13 · the allocator handing every caller the same value
mutate full "the allocator handing the same value to every caller" \
  "100 successive allocations are all distinct" \
  "$PROPOSAL" \
  's/       set next_value = public\.document_number_counters\.next_value \+ 1,/       set next_value = public.document_number_counters.next_value,/'

# 14 · the watermark bump removed — an old deployment's MAX()+1 insert leaves the
#      counter BEHIND the data, which is the mixed-deploy window during cutover.
mutate pg "the watermark bump removed from the claim trigger" \
  "no counter is behind the data it is supposed to lead" \
  "$PROPOSAL" \
  's/      insert into public\.document_number_counters \(user_id, kind, prefix, year, next_value\)\n           values \(new\.user_id, .quote., v_parts\[1\], v_year, \(v_parts\[3\]\)::int \+ 1\)/      insert into public.document_number_counters (user_id, kind, prefix, year, next_value)\n           values (new.user_id, '"'"'quote'"'"', v_parts[1], v_year, 1)/'

# 15 · counter seeding neutered, so the first allocation lands on a live series.
#      ⚠️ FULL, NOT STATIC. The static check only asserts a seeding statement
#      EXISTS; a statement that seeds the wrong value still matches it. Run as
#      static, this mutation survived.
mutate full "counter seeding neutered" \
  "the counter continues tenant A's existing series" \
  "$PROPOSAL" \
  's/       max\(\(\(regexp_match\(q\.quote_number/       1 + 0 * max(((regexp_match(q.quote_number/'

# 16 · tenant scope removed from the counter key
mutate static "tenant dropped from the counter key" \
  "allocation is scoped to tenant + prefix + year" \
  "$PROPOSAL" \
  's/constraint document_number_counters_pkey primary key \(user_id, kind, prefix, year\)/constraint document_number_counters_pkey primary key (kind, prefix, year)/'

# 17 · year scope removed — the annual reset
mutate static "year dropped from the counter key" \
  "allocation is scoped to tenant + prefix + year" \
  "$PROPOSAL" \
  's/primary key \(user_id, kind, prefix, year\)/primary key (user_id, kind, prefix)/'

# 18 · ⭐ PREFIX CHANGE, AND CHANGE BACK. Make the resolver ignore the owner's
#      explicit setting; the configured prefix stops taking effect at all.
mutate pg "the configured prefix ignored by the resolver" \
  "changing the prefix starts a NEW series" \
  "$PROPOSAL" \
  's/  if v_prefix is not null then return v_prefix; end if;\n\n  -- The prefix this tenant is already using/  if false then return v_prefix; end if;\n\n  -- The prefix this tenant is already using/'

echo ""
echo "  ── tenant isolation ──"

# 19 · the boundary removed from the allocator
mutate full "the cross-tenant boundary removed from the allocator" \
  "a signed-in caller cannot allocate for another business" \
  "$PROPOSAL" \
  's/  if v_caller is not null and v_caller <> v_user then\n    raise exception .allocate_quote_number: cannot allocate a number for another business.;\n  end if;//'

# 20 · ⭐⭐ THE PREFIX RESOLVER RE-EXPOSED (defence A). It reads another business's
#      configured prefix, numbering and company initials.
mutate static "the prefix resolver granted to authenticated again" \
  "the prefix resolver has NO direct execute grant" \
  "$PROPOSAL" \
  's/revoke all on function public\.quote_number_prefix\(uuid\) from authenticated;/grant execute on function public.quote_number_prefix(uuid) to authenticated;/'

# 21 · and its internal boundary removed (defence B), which is what has to hold
#      if a future migration restores a grant by accident
mutate static "the prefix resolver's own tenant boundary removed" \
  "the prefix resolver ALSO enforces the tenant boundary" \
  "$PROPOSAL" \
  's/  if v_caller is not null and v_caller <> p_user then\n    raise exception .quote_number_prefix: cannot resolve the prefix of another business.;\n  end if;//'

# 22 · both defences at once, measured on a REAL server where GRANTs are enforced
#      ⚠️ pg mode is not optional here: PGlite runs everything as one superuser,
#      and a superuser bypasses EXECUTE checks, so a revoked function still runs.
mutate pg "both prefix defences removed together" \
  "the boundary INSIDE it still refuses" \
  "$PROPOSAL" \
  's/  if v_caller is not null and v_caller <> p_user then\n    raise exception .quote_number_prefix: cannot resolve the prefix of another business.;\n  end if;//'

# 23 · a client write policy on the counter (rewind and reissue)
mutate static "a client write policy on the counter table" \
  "the counter table has no client write policy" \
  "$PROPOSAL" \
  's/create policy "document_number_counters: select own" on public\.document_number_counters/create policy "document_number_counters: update own" on public.document_number_counters\n  for update to authenticated using (auth.uid() = user_id);\ncreate policy "document_number_counters: select own" on public.document_number_counters/'

# 24 · a client write policy on the CLAIM registry — free a number, reissue it
mutate static "a client write policy on the claim registry" \
  "the registry has no client write policy" \
  "$PROPOSAL" \
  's/create policy "document_number_claims: select own" on public\.document_number_claims/create policy "document_number_claims: delete own" on public.document_number_claims\n  for delete to authenticated using (auth.uid() = user_id);\ncreate policy "document_number_claims: select own" on public.document_number_claims/'

# 25 · anon handed the allocator directly
mutate static "the allocator granted to anon" \
  "anon is NOT granted the allocator" \
  "$PROPOSAL" \
  's/grant execute on function public\.allocate_quote_number\(uuid\) to authenticated;/grant execute on function public.allocate_quote_number(uuid) to anon;/'

echo ""
echo "  ── the doors ──"

# 26 · browser MAX()+1 reintroduced
mutate static "browser MAX()+1 reintroduced in lib/utils" \
  "the browser generator is gone from lib/utils" \
  "$UTILS" \
  's/export function getInitials/export function generateQuoteNumber(i: number): string { return `EPS-2026-${i}` }\nexport function getInitials/'

# 27 · a door that defines its own generator locally
mutate static "a door computing its own number again" \
  "no app file computes a quote number" \
  "$NEWQ" \
  's/    const alloc = await allocateQuoteNumber\(supabase\)/    const generateQuoteNumber = (i: number) => `EPS-${i}`\n    const alloc = await allocateQuoteNumber(supabase)/'

# 28 · SQL MAX()+1 back inside the allocator
mutate static "SQL MAX()+1 put back inside the allocator" \
  "the allocator never scans quotes for a maximum" \
  "$PROPOSAL" \
  's/  v_prefix := public\.quote_number_prefix\(v_user\);/  select max(length(quote_number)) into v_year from public.quotes;\n  v_prefix := public.quote_number_prefix(v_user);/'

# 29 · public booking left on its own allocator
mutate static "book_service left on its own MAX()+1" \
  "book_service() is re-routed through the allocator" \
  "$PROPOSAL" \
  "s/p\.proname = 'book_service'/p.proname = 'book_service_disabled'/"

mutate static "submit_booking left on its own MAX()+1" \
  "submit_booking() is re-routed through the allocator" \
  "$PROPOSAL" \
  "s/p\.proname = 'submit_booking'/p.proname = 'submit_booking_disabled'/"

# 30 · the seam given a fallback that computes a number when the RPC fails
mutate static "a computed fallback added to the app seam" \
  "no app file computes a quote number" \
  "$SEAM" \
  's/  if \(error\) return \{ error: error\.message \}/  if (error) return { quoteNumber: generateQuoteNumber(1) }/'

# 30b · ⭐ THE DOOR INVENTORY TRIPWIRE. The per-door checks already catch a door
#       that fails to allocate. What they cannot catch is a door DISAPPEARING from
#       the inventory — a quote creation path that stops being recognised as one
#       is not defended by a check that only runs over recognised doors.
#       ⚠️ Reclassifying the builder by dropping its `quote_number` key does NOT
#       work: the insert object still names the column, so it stays an allocation
#       door. The door has to leave the RECOGNISED SET, which is what this does.
mutate static "a creation door quietly leaves the inventory" \
  "browser creation doors" \
  "$NEWQ" \
  "s/await supabase\.from\('quotes'\)\.insert\(\{/await supabase.from('quotes_gone').insert({/"

# 30c · ⭐⭐ THE ANNUAL RESET, at its actual source. The year must come from now();
#       a pinned year would make every future year share one sequence.
#       pg mode: the check measures the allocator's output against now() on a real
#       server in one statement.
mutate pg "the allocator's year pinned to a literal" \
  "the year the allocator emits is read from now()" \
  "$PROPOSAL" \
  's/  v_year   := extract\(year from now\(\)\)::int;/  v_year   := 2020;/'

echo ""
echo "  ── claims must be PERMANENT ──"

# ⭐⭐⭐ 31 · THE RELEASE MODEL, PUT BACK. This is the defect the review caught:
#        freeing a claim once no row carries the number downgrades the invariant
#        from "a number this tenant has EVER used" to "a number currently in
#        use". Re-add a release trigger + function and the create → delete →
#        stranger-takes-it sequence starts succeeding again.
#        full mode: PGlite can now DELETE from `quotes` (replica identity is
#        pinned in the guard), so this no longer needs a real server.
mutate full "a release path re-added, so a deleted number is freed" \
  "a DIFFERENT quote cannot take a deleted quote's number" \
  "$PROPOSAL" \
  's/  drop trigger if exists quotes_release_document_number on public\.quotes;\n\n  -- 4 · /  create function public.release_document_number() returns trigger language plpgsql security definer set search_path to '"'"'public'"'"', '"'"'pg_temp'"'"' as $rel$ begin delete from public.document_number_claims where user_id = old.user_id and kind = '"'"'quote'"'"' and number = old.quote_number; return null; end; $rel$;\n  create trigger quotes_release_document_number after delete on public.quotes for each row execute function public.release_document_number();\n\n  -- 4 · /'

# 32 · ⭐ A DELETE STATEMENT AGAINST THE REGISTRY, ANYWHERE. The static rule is
#      absolute — nothing in this file may delete a claim — so it is pinned
#      independently of whether any particular path exercises it.
mutate static "a claim deletion added to the migration" \
  "nothing in the proposal ever DELETES a claim" \
  "$PROPOSAL" \
  's/-- ── 9 · stage 2 — PARKED BY OWNER DECISION/delete from public.document_number_claims where number = '"'"'x'"'"';\n\n-- ── 9 · stage 2 — PARKED BY OWNER DECISION/'

# 33 · ⭐⭐ THE HOLDER CHECK REPLACED BY A BARE ALLOW. If the trigger stops asking
#      WHICH record is reclaiming the number and simply permits any second
#      comer, permanence collapses into the old released-claim behaviour without
#      a release path being visible anywhere.
mutate full "the holder identity check dropped, so anyone may reclaim" \
  "a DIFFERENT quote cannot take a deleted quote's number" \
  "$PROPOSAL" \
  's/    if not coalesce\(v_held, false\) then/    if false then/'

# 34 · ⭐ THE IDENTITY ITSELF. Matching on the number alone rather than on the
#      record id makes every holder row equivalent — a stranger inherits the
#      right to reuse the number from whoever held it first.
mutate full "the holder lookup ignores the record id" \
  "a DIFFERENT quote cannot take a deleted quote's number" \
  "$PROPOSAL" \
  's/       and number = new\.quote_number and record_id = new\.id;/       and number = new.quote_number;/'

# 35 · ⭐⭐ THE HOLDER SEED REMOVED. Claims still cover history, but no EXISTING
#      quote is recorded as holding its own number — so the first Undo of any
#      pre-existing quote is refused and the quote is lost. The migration's own
#      apply-time assertion is what must stop this.
mutate full "existing rows not seeded as holders of their own numbers" \
  "are not recorded as holders of their own number" \
  "$PROPOSAL" \
  's/  select q\.user_id, .quote., q\.quote_number, q\.id\n    from public\.quotes q\n   where q\.quote_number is not null/  select q.user_id, '"'"'quote'"'"', q.quote_number, q.id\n    from public.quotes q\n   where q.quote_number is not null and false/'

# 36 · ⭐ THE HOLDER SEED MADE DISTINCT-BY-NUMBER. Subtler than removing it: the
#      duplicate pairs lose one holder each, so exactly one row of each pair can
#      never be restored after a delete.
mutate full "the holder seed collapsed to one row per number" \
  "are not recorded as holders of their own number" \
  "$PROPOSAL" \
  's/  insert into public\.document_number_claim_holders \(user_id, kind, number, record_id\)\n  select q\.user_id, .quote., q\.quote_number, q\.id/  insert into public.document_number_claim_holders (user_id, kind, number, record_id)\n  select distinct on (q.user_id, q.quote_number) q.user_id, '"'"'quote'"'"', q.quote_number, q.id/'

# 37 · ⛔⛔ AN ON DELETE CASCADE FK FROM THE HOLDER HISTORY TO quotes. This is the
#      most dangerous available regression precisely because it looks like good
#      hygiene: referential integrity quietly deletes the history whose entire
#      job is to outlive the row.
mutate static "an FK from holder history to quotes" \
  "the holder history has NO foreign key to quotes" \
  "$PROPOSAL" \
  's/  constraint document_number_claim_holders_user_id_fkey/  constraint document_number_claim_holders_record_fkey\n    foreign key (record_id) references public.quotes(id) on delete cascade,\n  constraint document_number_claim_holders_user_id_fkey/'

# 38 · a client write policy on the holder history — delete your own holder row
#      and the number is yours to hand to a different quote
mutate static "a client write policy on the holder history" \
  "the holder history has no client write policy" \
  "$PROPOSAL" \
  's/create policy "document_number_claim_holders: select own" on public\.document_number_claim_holders/create policy "document_number_claim_holders: delete own" on public.document_number_claim_holders\n  for delete to authenticated using (auth.uid() = user_id);\ncreate policy "document_number_claim_holders: select own" on public.document_number_claim_holders/'

# 39 · ⭐ RENUMBERING MUST SPEND BOTH. An UPDATE away from a number must not free
#      it; this is the other way a number is vacated.
mutate full "the number a quote is renumbered AWAY from is freed" \
  "the number it was MOVED OFF is still spent" \
  "$PROPOSAL" \
  's/  if tg_op = .UPDATE. then\n    if new\.quote_number is not distinct from old\.quote_number then\n      return new;\n    end if;\n  end if;\n\n  -- ── 1 · THE BARRIER/  if tg_op = '"'"'UPDATE'"'"' then\n    return new;\n  end if;\n\n  -- ── 1 · THE BARRIER/'

# 40 · ⚠️⚠️ THE CRLF ANCHOR TRAP, which cost S113 a production apply. Remove the
#      transport normalisation and a stored body that comes back CRLF makes every
#      LF anchor match zero times.
mutate static "the CRLF transport normalisation removed" \
  "the in-place swap normalises line endings at transport" \
  "$PROPOSAL" \
  "s/  v_fn := replace\(v_fn, chr\(13\), ''\);   -- same transport normalisation as above/  perform 1;/"

# 41 · ⛔ THE OWNER'S STAGE-2 DECISION. Parked is a decision, not a task.
mutate static "the owner's park decision removed from the file" \
  "stage 2 is PARKED by owner decision" \
  "$PROPOSAL" \
  's/-- ── 9 · stage 2 — PARKED BY OWNER DECISION ──────────────────────────────────/-- ── 9 · stage 2, deliberately NOT executed here ─────────────────────────────/'

# 42 · ⭐ A restore door narrowed so it stops carrying whole rows. Both Undo paths
#      depend on select('*') to keep id AND created_at; without created_at a
#      restored historical duplicate pair collides inside the stage-1 index.
mutate static "a restore door stops loading whole rows" \
  "loads whole rows, so a restore keeps its id and created_at" \
  "src/app/dashboard/quotes/page.tsx" \
  "s/\.select\('\*'\)\.eq\('id', id\)/.select('id, quote_number').eq('id', id)/"



# 33 · ⭐ THE HARNESS TESTS ITSELF. A mutation that changes no bytes must be
#      reported as a HARNESS BUG rather than counted as a survivor or a pass.
echo ""
echo "  ── self-test: a mutation that changes nothing ──"
restore; hide_pglite
before=$(cksum < "$PROPOSAL")
perl -0pi -e 's/THIS_ANCHOR_DOES_NOT_EXIST_ANYWHERE/x/' "$PROPOSAL"
after=$(cksum < "$PROPOSAL")
if [ "$before" = "$after" ]; then
  echo "  ✓ caught: a no-op mutation is detected as a HARNESS BUG, not a survivor"
  pass=$((pass+1))
else
  echo "  ✗ SURVIVED: the no-op self-test changed bytes — the detector is broken"
  fail=$((fail+1))
fi

echo ""
echo "══ result ══════════════════════════════════════════════════════════════"
echo ""
echo "  $pass caught, $fail survived"
echo ""
[ "$fail" -eq 0 ] || exit 1
