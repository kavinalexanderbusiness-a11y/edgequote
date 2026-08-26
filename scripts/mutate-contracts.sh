#!/usr/bin/env bash
# ── Mutation test for verify:contracts ───────────────────────────────────────
#
# An assertion that cannot fail is not a guard, it is decoration. This breaks
# each load-bearing rule ON PURPOSE, one at a time, and requires the named check
# to go RED. A mutation that stays green means the guard was never watching.
#
#   bash scripts/mutate-contracts.sh
#
# ⚠️⚠️ COMMIT FIRST. This edits real files and restores them from a backup in a
# trap. An interrupted run cannot leave a mutation behind, but uncommitted work
# in these files is still the thing most likely to be lost.
#
# Only the STATIC half runs: it needs no database, so each mutation costs about
# two seconds instead of the minutes a PGlite rebuild takes. The behavioural half
# proves itself by construction — every refusal asserts the ERROR TEXT through
# refusedBy(), so a statement failing for an unrelated reason is reported as
# "refused, but for the wrong reason" rather than counted as a pass.

set -uo pipefail
cd "$(dirname "$0")/.."

SCHEMA="supabase/migrations/29999999000000_contracts_v1_TEMP.sql"
LIB="src/lib/contracts.ts"
DETAIL="src/app/dashboard/contracts/[id]/page.tsx"
LIST="src/app/dashboard/contracts/page.tsx"

BACKUP_DIR="$(mktemp -d)"
cp "$SCHEMA" "$BACKUP_DIR/schema.sql"
cp "$LIB"    "$BACKUP_DIR/lib.ts"
cp "$DETAIL" "$BACKUP_DIR/detail.tsx"
cp "$LIST"   "$BACKUP_DIR/list.tsx"

# ⭐ HIDE PGLITE FOR THE DURATION. The guard treats PGlite as an OPTIONAL
# dependency and skips its behavioural half cleanly when absent, so moving the
# package aside turns each mutation from minutes into seconds. This is an
# ENVIRONMENT fact, not a flag: there is deliberately no "skip the proof" switch
# inside verify-contracts.ts that CI could ever set by accident.
PGLITE_DIR="node_modules/@electric-sql/pglite"
PGLITE_HIDDEN="node_modules/@electric-sql/.pglite-hidden-by-mutation-test"
[ -d "$PGLITE_DIR" ] && mv "$PGLITE_DIR" "$PGLITE_HIDDEN"

restore() {
  cp "$BACKUP_DIR/schema.sql" "$SCHEMA"
  cp "$BACKUP_DIR/lib.ts"     "$LIB"
  cp "$BACKUP_DIR/detail.tsx" "$DETAIL"
  cp "$BACKUP_DIR/list.tsx"   "$LIST"
}
cleanup() {
  restore
  [ -d "$PGLITE_HIDDEN" ] && mv "$PGLITE_HIDDEN" "$PGLITE_DIR"
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT INT TERM

pass=0; fail=0

# WARNING: 2>&1, NOT 2>/dev/null. check() writes failures with console.error, so
# discarding stderr throws away every failure marker and reports "0 caught" for a
# guard that was working perfectly. A mutation harness that cannot see failures
# is itself the thing most worth testing.
run_static() { npx tsx scripts/verify-contracts.ts 2>&1; }

# mutate <name> <expected-check-substring> <file> <sed-expression>
mutate() {
  local name="$1" expect="$2" file="$3" expr="$4"
  restore
  perl -0pi -e "$expr" "$file"
  if ! grep -q "$(printf '%s' "$expect")" <(run_static | grep '✗' || true); then
    echo "  ✗ SURVIVED: $name"
    echo "      nothing went red — expected a failure naming: $expect"
    fail=$((fail+1))
  else
    echo "  ✓ caught: $name"
    pass=$((pass+1))
  fi
}

echo ""
echo "══ mutations ═══════════════════════════════════════════════════════════"
echo ""

# ── The separation of the three truths ──────────────────────────────────────
mutate "a trigger that creates a recurring series on signature" \
  "nothing in the contracts schema writes job_recurrences" \
  "$SCHEMA" \
  "s/-- .. 7 . audit/insert into public.job_recurrences (user_id, start_date) values (new.user_id, current_date);\n-- 7 audit/"

mutate "the library booking work when a contract activates" \
  "writes no job, invoice or payment" \
  "$LIB" \
  "s/export async function terminateContract/export async function bookIt(sb: any) { await sb.from('jobs').insert({}) }\nexport async function terminateContract/"

mutate "renewal awareness reaching for Session 53's engine" \
  "does not import the Session 53 renewal engine" \
  "$LIB" \
  "s|import type \{ SupabaseClient \}|import \{ planRenewal \} from '\@/lib/signals/renewal'\nimport type \{ SupabaseClient \}|"

mutate "a contract term read off the recurrence" \
  "no contract date is copied from a recurrence" \
  "$SCHEMA" \
  "s/\"end_date\"       date,/\"end_date\"       date, -- recurrence.end_date\n  \"x_end\" date,/"

# ── Honest status ───────────────────────────────────────────────────────────
mutate "expiry stored as a column instead of derived" \
  "there is no stored expired flag" \
  "$SCHEMA" \
  "s/\"archived_at\" timestamp with time zone,/\"expired_at\" timestamp with time zone,\n  \"archived_at\" timestamp with time zone,/"

mutate "a draft that can silently expire" \
  "only a LIVE agreement can lapse" \
  "$SCHEMA" \
  "s/select p_status = 'active' and p_end_date is not null and p_end_date < p_today;/select p_end_date is not null and p_end_date < p_today;/"

mutate "the app disagreeing with the database about expiry" \
  "the app mirrors the same rule" \
  "$LIB" \
  "s/return c.status === 'active' \&\& !!c.end_date \&\& daysUntil\(c.end_date, today\) < 0/return !!c.end_date \&\& daysUntil(c.end_date, today) < 0/"

mutate "a terminated contract with no moment it ended" \
  "terminated is paired with its stamp" \
  "$SCHEMA" \
  "s/check \(\(status = 'terminated'\) = \(terminated_at is not null\)\)/check (status <> 'terminated' or terminated_at is not null)/"

# ── Tenancy ─────────────────────────────────────────────────────────────────
mutate "the recurrence link downgraded to a bare id" \
  "the recurrence link is a TENANT WELD" \
  "$SCHEMA" \
  "s/foreign key \(user_id, job_recurrence_id\) references public.job_recurrences\(user_id, id\)/foreign key (job_recurrence_id) references public.job_recurrences(id)/"

mutate "the document link downgraded to a bare id" \
  "the document link is a TENANT WELD" \
  "$SCHEMA" \
  "s/foreign key \(user_id, document_id\) references public.documents\(user_id, id\)/foreign key (document_id) references public.documents(id)/"

mutate "a contract that needs no customer" \
  "a contract without a customer is impossible" \
  "$SCHEMA" \
  "s/\"customer_id\" uuid not null,/\"customer_id\" uuid,/"

mutate "anon left with the default grants" \
  "anon is explicitly revoked" \
  "$SCHEMA" \
  "s/revoke all on public.contracts from anon;//"

# ── Frozen truth ────────────────────────────────────────────────────────────
mutate "a sent contract whose version can be swapped" \
  "a sent contract cannot be re-pointed" \
  "$SCHEMA" \
  "s/has already been sent\. The version it points at is the record of what was sent/this contract changed/"

mutate "the signed version made deletable by cascade" \
  "the signed version FK is RESTRICT" \
  "$SCHEMA" \
  "s/references public.document_versions\(user_id, id\) on delete restrict/references public.document_versions(user_id, id) on delete set null (document_version_id)/"

mutate "a signed term that can be edited after the fact" \
  "a signed contract's term cannot be edited" \
  "$SCHEMA" \
  "s/The term of a signed contract cannot be edited/the term moved/"

mutate "activation accepting any signature at all" \
  "active requires a real signature against THIS version" \
  "$SCHEMA" \
  "s/and s.version_id = new.document_version_id//"

# ── One engine ──────────────────────────────────────────────────────────────
mutate "a second signature request table" \
  "S83 defines NO signature table of its own" \
  "$SCHEMA" \
  "s/create table if not exists public.contracts \(/create table if not exists public.contract_signature_requests (id uuid primary key);\ncreate table if not exists public.contracts (/"

mutate "the library writing S74's signature table directly" \
  "never writes S74 signature tables directly" \
  "$LIB" \
  "s|const \{ data, error \} = await sb.from\('contracts'\).insert|await sb.from('document_signature_requests').insert({});\n  const { data, error } = await sb.from('contracts').insert|"

# ── Legal honesty and the portal boundary ───────────────────────────────────
mutate "a claim that agreements are legally binding" \
  "make no claim of legal enforceability" \
  "$LIST" \
  "s/It does not provide legal advice/These agreements are legally binding/"

mutate "a signature presented as proof of identity" \
  "distinguishes intent from identity" \
  "$DETAIL" \
  "s/evidence of intent, not proof of identity/proof of identity/"

# ── Mobile ──────────────────────────────────────────────────────────────────
mutate "the detail actions shrunk to half-width on a phone" \
  "action buttons are full-width on a phone" \
  "$DETAIL" \
  "s/className=\"w-full sm:w-auto\"//g"

mutate "an agreement preview that scrolls the whole page sideways" \
  "scrolls inside its own box" \
  "$DETAIL" \
  "s/overflow-x-auto//"

echo ""
echo "══ result ══════════════════════════════════════════════════════════════"
echo ""
echo "  $pass caught, $fail survived"
echo ""
[ "$fail" -eq 0 ] || exit 1
