#!/usr/bin/env bash
# ── Mutation test for verify:documents ───────────────────────────────────────
#
# An assertion that cannot fail is not a guard, it is decoration. This breaks
# each load-bearing rule ON PURPOSE, one at a time, and requires the named check
# to go RED. A mutation that stays green means the guard was never watching.
#
#   bash scripts/mutate-documents.sh
#
# Only the STATIC half runs here (sections 1-11): it needs no database, so each
# mutation costs about two seconds instead of the ten minutes a PGlite rebuild
# takes. The behavioural half proves itself by construction — every one of its
# refusals now asserts the ERROR TEXT via refusedBy(), so a statement that fails
# for an unrelated reason is reported as "refused, but for the wrong reason".
#
# ⚠️ It edits real files and restores them from a backup in a trap, so an
# interrupted run cannot leave a mutation behind.

set -uo pipefail
cd "$(dirname "$0")/.."

SCHEMA="supabase/migrations/20260824090000_documents_signatures_v1.sql"
PAD="src/components/documents/SignaturePad.tsx"
BACKUP_DIR="$(mktemp -d)"
cp "$SCHEMA" "$BACKUP_DIR/schema.sql"
cp "$PAD" "$BACKUP_DIR/pad.tsx"

# ⭐ HIDE PGLITE FOR THE DURATION. The guard treats PGlite as an OPTIONAL
# dependency and skips its behavioural half cleanly when the package is absent —
# so moving the package aside turns each mutation run from ten minutes into about
# three seconds. This is an ENVIRONMENT fact, not a flag in the guard: there is
# deliberately no "skip the proof" switch in verify-documents.ts that CI could
# ever set by accident.
PGLITE_DIR="node_modules/@electric-sql/pglite"
PGLITE_HIDDEN="node_modules/@electric-sql/.pglite-hidden-by-mutation-test"
[ -d "$PGLITE_DIR" ] && mv "$PGLITE_DIR" "$PGLITE_HIDDEN"

restore() {
  cp "$BACKUP_DIR/schema.sql" "$SCHEMA"
  cp "$BACKUP_DIR/pad.tsx" "$PAD"
}
cleanup() {
  restore
  [ -d "$PGLITE_HIDDEN" ] && mv "$PGLITE_HIDDEN" "$PGLITE_DIR"
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT INT TERM

pass=0; fail=0

# Run only the static half. The guard exits non-zero on any failure, so the
# signal we want is whether THIS NAMED CHECK appears as a failure.
run_static() {
  # WARNING: 2>&1, NOT 2>/dev/null: check() writes failures with console.error, so
  # discarding stderr throws away every failure marker and reports "0 caught" for
  # a guard that was working perfectly. A mutation harness that cannot see
  # failures is itself the thing most worth testing.
  npx tsx scripts/verify-documents.ts 2>&1
}

# mutate <name> <expected-check-substring> <file> <sed-expression>
mutate() {
  local name="$1" expect="$2" file="$3" expr="$4"
  restore
  perl -0pi -e "$expr" "$file"
  local backup="$BACKUP_DIR/schema.sql"
  [ "$file" = "$PAD" ] && backup="$BACKUP_DIR/pad.tsx"
  if diff -q "$file" "$backup" >/dev/null; then
    echo "  [NO-OP]    $name (pattern no longer matches; fix this script)"
    fail=$((fail+1))
    restore
    return
  fi
  local out; out="$(run_static)"
  # NOTE: match the failure marker by its UTF-8 BYTES (E2 9C 97), never by the
  # glyph. Git-Bash's locale mangles it in transit, so a glyph comparison matched
  # nothing and reported "0 caught" for a guard that was catching everything.
  if printf '%s' "$out" | grep -aP '\xe2\x9c\x97' | grep -qF "$expect"; then
    echo "  [CAUGHT]   $name"
    pass=$((pass+1))
  else
    echo "  [SURVIVED] $name"
    echo "      expected a FAILURE naming: $expect"
    fail=$((fail+1))
  fi
  restore
}

echo ""
echo "══ mutation test · verify:documents ════════════════════════════════════"
# 18 · assignment regresses to the crew-only predicate (S65's model ignored)
mutate "the crew door reverts to a hand-rolled crew_id check" \
  "CANONICAL predicate" "$SCHEMA" \
  "s/public\.crew_assignment_covers\(j\.crew_id, j\.technician_id, v_crew, v_tech\)/j.crew_id = v_crew/"

# 19 · the null guard moves back to the crew, refusing crewless technicians
mutate "the crew door guards on v_crew instead of v_tech" \
  "guards on the technician, not the crew" "$SCHEMA" \
  "s/if v_employer is null or v_tech is null then/if v_employer is null or v_crew is null then/"

echo ""

# 1 · privacy: the bucket becomes public
mutate "the documents bucket is made PUBLIC" \
  "the documents bucket is PRIVATE" "$SCHEMA" \
  "s/'documents', 'documents', false/'documents', 'documents', true/"

# 2 · the storage policy stops being owner-scoped
mutate "a storage policy drops the owner-folder rule" \
  "owner-scoped by folder" "$SCHEMA" \
  "s/\(storage\.foldername\(name\)\)\[1\] = \(auth\.uid\(\)\)::text/true/"

# 3 · entity link: exactly-one becomes at-most-one
mutate "documents_one_entity allows zero or two homes" \
  "exactly one entity is enforced" "$SCHEMA" \
  "s/documents_one_entity check \(([^;]*?)= 1\s*\)/documents_one_entity check (true)/s"

# 4 · visibility stops defaulting to the safe value
mutate "visibility defaults to customer instead of internal" \
  "visibility defaults to internal" "$SCHEMA" \
  "s/\"visibility\"   text default 'internal' not null/\"visibility\"   text default 'customer' not null/"

# 5 · worker visibility no longer requires a visit
mutate "worker visibility without a job link is allowed" \
  "worker visibility requires a job link" "$SCHEMA" \
  "s/documents_worker_needs_job check \(\s*visibility <> 'worker' or job_id is not null\s*\)/documents_worker_needs_job check (true)/s"

# 6 · tenancy: anon is handed the table
mutate "anon is granted the documents table" \
  "grants NOTHING to anon" "$SCHEMA" \
  "s/grant select, insert, update, delete on table public\.documents to authenticated;/grant select on table public.documents to anon;\ngrant select, insert, update, delete on table public.documents to authenticated;/"

# 7 · replay defence removed
mutate "a request can be signed more than once" \
  "one request can be satisfied exactly once" "$SCHEMA" \
  "s/constraint document_signatures_one_per_request unique \(request_id\)/constraint document_signatures_one_per_request check (true)/"

# 8 · signatures become editable
mutate "signatures stop being append-only" \
  "append-only for every role" "$SCHEMA" \
  "s/before update or delete on public\.document_signatures/before truncate on public.document_signatures/"

# 9 · the signer becomes client-supplied
mutate "the signer identity comes from the payload" \
  "resolved from the token, not the payload" "$SCHEMA" \
  "s/select t\.user_id, t\.customer_id into v_tenant, v_customer/select t.user_id, null::uuid into v_tenant, v_customer/"

# 10 · versions become mutable
mutate "a version's content pointer becomes swappable" \
  "a version row is immutable" "$SCHEMA" \
  "s/before update or delete on public\.document_versions/before truncate on public.document_versions/"

# 11 - the portal starts leaking storage paths
#    Targets a line unique to portal_get_documents. The first version of this
#    mutation edited "'file_name', v.file_name," which appears ONLY in
#    portal_document_file and crew_job_documents, both of which are SUPPOSED to
#    resolve a path. It never touched the projection it named, so its survival
#    proved nothing about the guard. A mutation that misses its target is a
#    false negative dressed as a finding.
mutate "portal_get_documents projects the storage path" \
  "never projects a storage path" "$SCHEMA" \
  "s/      r\.statement     as signature_statement,/      v.storage_path as leaked_path,\n      r.statement     as signature_statement,/"

# 12 · the crew door widens to the customer's copy
mutate "the crew door returns customer-visible documents" \
  "returns only worker-visibility documents" "$SCHEMA" \
  "s/and d\.visibility = 'worker'/and d.visibility in ('worker','customer')/"

# 13 · audit starts carrying the drawn mark
mutate "an audit payload carries the signature path" \
  "no audit call carries the signature image" "$SCHEMA" \
  "s/jsonb_build_object\('purpose', new\.purpose, 'version_no', v_no, 'source', new\.source\)/jsonb_build_object('purpose', new.purpose, 'signature_path', new.signature_path)/"

# 14 · the audit apply-order precondition is deleted
mutate "the audit apply-order precondition is removed" \
  "apply-order dependency on the audit trail is enforced" "$SCHEMA" \
  "s/to_regprocedure\('public\.audit_log\(uuid,text,text,uuid,text,uuid,jsonb,jsonb,jsonb\)'\) is null/false/"

# 15 · documents grows its own audit engine
mutate "documents defines its own audit_log" \
  "defines NO audit table or audit_log of its own" "$SCHEMA" \
  "s/create or replace function public\.audit_documents\(\)/create or replace function public.audit_log()/"

# 16 · mobile: the pad stops claiming the gesture
mutate "the signature pad allows browser touch scrolling" \
  "disables browser touch gestures" "$PAD" \
  "s/touchAction: 'none'/touchAction: 'auto'/"

# 17 · mobile: the DPR backing store is dropped
mutate "the signature pad drops the device-pixel-ratio scale" \
  "device-pixel-ratio backing store" "$PAD" \
  "s/ctx\.scale\(dpr, dpr\)/void dpr/"

echo ""
echo "──────────────────────────────────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "OK  mutation test - $pass/$((pass+fail)) mutations caught. Every rule can go red."
else
  echo "❌ mutation test — $fail SURVIVED, $pass caught."
  echo "   A surviving mutation means that assertion is decoration, not a guard."
fi
echo ""
exit "$fail"
