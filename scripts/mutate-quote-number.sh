#!/usr/bin/env bash
# ── Mutation test for verify:quote-number-integrity ──────────────────────────
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
# ⭐ TWO SPEEDS. Most mutations are caught by the STATIC half, which needs no
# database, so PGlite is hidden and each costs seconds. The mutations that can
# only be caught by executing SQL (a caller supplying its own number, a
# cross-tenant allocation, 100-way allocation) are run with PGlite present and
# cost a couple of minutes each. Which speed a mutation needs is stated, not
# guessed.

set -uo pipefail
cd "$(dirname "$0")/.."

PROPOSAL="supabase/proposals/quote_number_integrity_v1.sql"
UTILS="src/lib/utils.ts"
SEAM="src/lib/quoteNumber.ts"
NEWQ="src/app/dashboard/quotes/new/page.tsx"
GUARD="scripts/verify-quote-number-integrity.ts"

BACKUP_DIR="$(mktemp -d)"
cp "$PROPOSAL" "$BACKUP_DIR/proposal.sql"
cp "$UTILS"    "$BACKUP_DIR/utils.ts"
cp "$SEAM"     "$BACKUP_DIR/seam.ts"
cp "$NEWQ"     "$BACKUP_DIR/newq.tsx"
cp "$GUARD"    "$BACKUP_DIR/guard.ts"

PGLITE_DIR="node_modules/@electric-sql/pglite"
PGLITE_HIDDEN="node_modules/@electric-sql/.pglite-hidden-by-mutation-test"
hide_pglite()   { [ -d "$PGLITE_DIR" ] && mv "$PGLITE_DIR" "$PGLITE_HIDDEN"; return 0; }
unhide_pglite() { [ -d "$PGLITE_HIDDEN" ] && mv "$PGLITE_HIDDEN" "$PGLITE_DIR"; return 0; }

restore() {
  cp "$BACKUP_DIR/proposal.sql" "$PROPOSAL"
  cp "$BACKUP_DIR/utils.ts"     "$UTILS"
  cp "$BACKUP_DIR/seam.ts"      "$SEAM"
  cp "$BACKUP_DIR/newq.tsx"     "$NEWQ"
  cp "$BACKUP_DIR/guard.ts"     "$GUARD"
}
cleanup() { restore; unhide_pglite; rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT INT TERM

pass=0; fail=0

# WARNING: 2>&1, NOT 2>/dev/null — check() writes failures with console.error, so
# discarding stderr throws away every failure marker and reports "0 caught" for a
# harness that was working perfectly.
run_guard() { npx tsx "$GUARD" 2>&1; }

# mutate <mode: static|full> <name> <expected-check-substring> <file> <perl-expr>
#
# ⚠️⚠️ A MUTATION THAT NEVER APPLIED LOOKS EXACTLY LIKE A GUARD THAT CAUGHT
# NOTHING — both leave the suite green, and the harness would report SURVIVED for
# a rule that is perfectly well defended. So the file is checksummed and "no
# change" is reported as a HARNESS BUG, loudly and separately.
# ⚠️ A changed file is still not necessarily the RIGHT change: an unescaped | or
# ( in a perl expression can match something unintended, change bytes, satisfy
# the checksum and mutate nothing that matters. Escape them.
mutate() {
  local mode="$1" name="$2" expect="$3" file="$4" expr="$5"
  restore
  if [ "$mode" = "static" ]; then hide_pglite; else unhide_pglite; fi
  local before after
  before=$(cksum < "$file")
  perl -0pi -e "$expr" "$file"
  after=$(cksum < "$file")
  if [ "$before" = "$after" ]; then
    echo "  ⚠ HARNESS BUG: $name"
    echo "      the mutation did not change $file — its anchor no longer matches."
    fail=$((fail+1)); return
  fi
  if ! grep -q "$(printf '%s' "$expect")" <(run_guard | grep '✗' || true); then
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

# 1 · remove the UNIQUE protection
mutate static "the UNIQUE barrier removed" \
  "a UNIQUE index protects" \
  "$PROPOSAL" \
  's/create unique index quotes_user_qnum_new_unique/create index quotes_user_qnum_new_unique/'

# 2 · reintroduce browser-side MAX()+1
mutate static "browser MAX()+1 reintroduced in lib/utils" \
  "the browser generator is gone from lib/utils" \
  "$UTILS" \
  's/export function getInitials/export function generateQuoteNumber(i: number): string { return `EPS-2026-${i}` }\nexport function getInitials/'

# 2b · and a caller that uses it again
mutate static "a door computing its own number again" \
  "no app file computes a quote number" \
  "$NEWQ" \
  's/    const alloc = await allocateQuoteNumber\(supabase\)/    const generateQuoteNumber = (i: number) => `EPS-${i}`\n    const alloc = await allocateQuoteNumber(supabase)/'

# 3 · reintroduce SQL MAX()+1 inside the allocator
mutate static "SQL MAX()+1 put back inside the allocator" \
  "the allocator never scans quotes for a maximum" \
  "$PROPOSAL" \
  's/  v_prefix := public\.quote_number_prefix\(v_user\);/  select max(length(quote_number)) into v_year from public.quotes;\n  v_prefix := public.quote_number_prefix(v_user);/'

# 4 · remove the tenant scope from the counter key
mutate static "tenant dropped from the counter key" \
  "allocation is scoped to tenant + prefix + year" \
  "$PROPOSAL" \
  's/constraint document_number_counters_pkey primary key \(user_id, kind, prefix, year\)/constraint document_number_counters_pkey primary key (kind, prefix, year)/'

# 5 · remove the year scope
mutate static "year dropped from the counter key" \
  "allocation is scoped to tenant + prefix + year" \
  "$PROPOSAL" \
  's/primary key \(user_id, kind, prefix, year\)/primary key (user_id, kind, prefix)/'

# 6 · remove the seeding, so the first allocation lands on a live series
#     ⚠️ FULL, NOT STATIC. The static check only asserts a seeding statement
#     EXISTS; a seeding statement that seeds the wrong thing still matches it. The
#     claim being made — "the counter continues the series" — is behavioural, and
#     only the from-zero half can test it. Run as static, this mutation survived.
mutate full "counter seeding neutered" \
  "the counter continues tenant A's existing series" \
  "$PROPOSAL" \
  's/       max\(\(\(regexp_match\(q\.quote_number/       1 + 0 * max(((regexp_match(q.quote_number/'

# 7 · drop the tenant-boundary check inside the allocator
#     FULL: the static text check and the behavioural refusal both matter, but the
#     behavioural one is the claim that counts.
mutate full "the cross-tenant boundary removed from the allocator" \
  "a signed-in caller cannot allocate for another business" \
  "$PROPOSAL" \
  's/  if v_caller is not null and v_caller <> v_user then\n    raise exception .allocate_quote_number: cannot allocate a number for another business.;\n  end if;//'

# 8 · let a client write the counter directly (rewind and reissue)
mutate static "a client write policy on the counter table" \
  "the counter table has no client write policy" \
  "$PROPOSAL" \
  's/create policy "document_number_counters: select own" on public\.document_number_counters/create policy "document_number_counters: update own" on public.document_number_counters\n  for update to authenticated using (auth.uid() = user_id);\ncreate policy "document_number_counters: select own" on public.document_number_counters/'

# 9 · public booking bypasses the allocator
mutate static "book_service left on its own MAX()+1" \
  "book_service() is re-routed through the allocator" \
  "$PROPOSAL" \
  "s/p\.proname = 'book_service'/p.proname = 'book_service_disabled'/"

mutate static "submit_booking left on its own MAX()+1" \
  "submit_booking() is re-routed through the allocator" \
  "$PROPOSAL" \
  "s/p\.proname = 'submit_booking'/p.proname = 'submit_booking_disabled'/"

# 10 · anon handed the allocator directly
mutate static "the allocator granted to anon" \
  "anon is NOT granted the allocator" \
  "$PROPOSAL" \
  's/grant execute on function public\.allocate_quote_number\(uuid\) to authenticated;/grant execute on function public.allocate_quote_number(uuid) to anon;/'

# 11 · the seam given a fallback that computes a number when the RPC fails
mutate static "a computed fallback added to the app seam" \
  "no app file computes a quote number" \
  "$SEAM" \
  's/  if \(error\) return \{ error: error\.message \}/  if (error) return { quoteNumber: generateQuoteNumber(1) }/'

# 12 · 100-way allocation returning duplicates
#      FULL: only executing it can show this.
mutate full "the allocator handing the same value to every caller" \
  "100 successive allocations are all distinct" \
  "$PROPOSAL" \
  's/       set next_value = public\.document_number_counters\.next_value \+ 1,/       set next_value = public.document_number_counters.next_value,/'

# 13 · a caller supplying an arbitrary number, with the barrier gone
#      FULL: the refusal is the database's, not a grep's.
mutate full "the barrier made non-unique so a supplied duplicate lands" \
  "a duplicate within one tenant is refused by the database" \
  "$PROPOSAL" \
  's/create unique index quotes_user_qnum_new_unique on public\.quotes/create index quotes_user_qnum_new_unique on public.quotes/'

# 14 · ⭐ THE HARNESS TESTS ITSELF. A mutation that changes no bytes must be
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
