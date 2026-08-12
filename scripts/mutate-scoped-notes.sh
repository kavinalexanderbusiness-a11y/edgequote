#!/usr/bin/env bash
# Mutation test for verify:scoped-notes — does the guard actually go RED when a
# protection is removed? A guard nobody has broken on purpose is decoration.
#
# Each case makes ONE real breach, runs the guard, and expects a non-zero exit.
#
# ⚠️⚠️ IT REFUSES TO RUN ON A DIRTY TREE, AND THAT RULE WAS LEARNED THE HARD WAY.
# The first version restored with `git checkout -- .` against UNCOMMITTED work
# and destroyed every tracked edit in the session. Worse, its "did the mutation
# apply?" probe was `git diff --quiet <file>` — which reports NO DIFF for an
# UNTRACKED file, so mutations to brand-new files were reported as "did not
# apply" while they had in fact applied and were then never restored. The tree
# was left quietly corrupted in two different directions at once.
#
# Both holes close the same way: require everything committed first. Then
# `git checkout -- .` restores exactly the committed state, every file under test
# is tracked so `git diff` can see it, and the worst case is a wasted run.
set -u

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Refusing to run: the working tree is dirty."
  echo "  This script mutates files and restores them with git. Uncommitted work"
  echo "  would be destroyed, and mutations to UNTRACKED files would be invisible"
  echo "  to the applied-check and never restored. Commit first, then re-run."
  exit 2
fi

PASS=0; FAIL=0
restore() { git checkout -- . 2>/dev/null; }
trap restore EXIT INT TERM

# $1 = name, $2 = file, $3 = perl expression applied in place
mutate() {
  local name="$1" file="$2" expr="$3"
  restore
  perl -0pi -e "$expr" "$file" 2>/dev/null
  if git diff --quiet -- "$file"; then
    # With a clean tree enforced above, every target is tracked — so this really
    # does mean the pattern missed, not that git cannot see the file.
    echo "  ~ $name — MUTATION DID NOT APPLY (pattern missed; this case proved nothing)"
    FAIL=$((FAIL+1)); return
  fi
  if npx tsx scripts/verify-scoped-notes.ts >/dev/null 2>&1; then
    echo "  ✗ $name — guard stayed GREEN through a real breach"
    FAIL=$((FAIL+1))
  else
    echo "  ✓ $name — guard went red"
    PASS=$((PASS+1))
  fi
}

echo ""
echo "=== 1. internal → customer visibility leak ==="

mutate "quotes.internal_notes added to the portal projection" \
  supabase/CANONICAL-get_portal_data.sql \
  's/qt\.notes, qt\.status/qt.notes, qt.internal_notes, qt.status/'

mutate "jobs.notes put back into the portal projection" \
  supabase/CANONICAL-get_portal_data.sql \
  's/completed_at, completion_summary from public\.jobs/completed_at, completion_summary, notes from public.jobs/'

mutate "customers.notes added to the portal customer projection" \
  supabase/CANONICAL-get_portal_data.sql \
  's/sms_opt_in, email_opt_in/sms_opt_in, notes, email_opt_in/'

mutate "QuotePDF renders the internal note beside the customer one" \
  src/components/quotes/QuotePDF.tsx \
  's/\{quote\.notes\}<\/Text>/{quote.notes}{quote.internal_notes}<\/Text>/'

mutate "the internal note is copied onto the invoice that prints" \
  "src/app/dashboard/quotes/[id]/page.tsx" \
  's/notes: quote\.notes,\s*\n(\s*)internal_notes: quote\.internal_notes,/notes: quote.internal_notes,\n$1internal_notes: quote.internal_notes,/'

mutate "the customer note is dropped into the internal field on duplicate" \
  src/components/quotes/QuoteList.tsx \
  's/notes: q\.notes, internal_notes: q\.internal_notes/notes: q.notes, internal_notes: q.notes/'

echo ""
echo "=== 2. missing tenant constraint ==="

mutate "crew_media loses its NOT NULL owner column" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  's/user_id       uuid not null references/user_id       uuid references/'

mutate "crew_media rows outlive their visit" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  's/job_id        uuid not null references public\.jobs\(id\) on delete cascade/job_id        uuid not null references public.jobs(id)/'

mutate "the crew catalogue read drops its owner scope" \
  src/app/api/crew/media/route.ts \
  "s/\.eq\('job_id', j\.id\)\.eq\('user_id', j\.user_id\)/.eq('job_id', j.id)/"

mutate "storage policies stop scoping by the owner folder" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  "s/\(storage\.foldername\(name\)\)\[1\] = \(auth\.uid\(\)\)::text/true/g"

echo ""
echo "=== 3. worker authorization bypass ==="

mutate "the crew door stops checking the crew assignment" \
  src/app/api/crew/media/route.ts \
  "s/\.eq\('id', jobId\)\.eq\('user_id', t\.user_id\)\.eq\('crew_id', t\.crew_id\)/.eq('id', jobId).eq('user_id', t.user_id)/"

mutate "the crew door stops re-checking the roster switches" \
  src/app/api/crew/media/route.ts \
  "s/\.eq\('auth_user_id', user\.id\)\.eq\('is_active', true\)\.is\('archived_at', null\)/.eq('auth_user_id', user.id)/"

mutate "the crew door stops asking the database for the role" \
  src/app/api/crew/media/route.ts \
  "s/if \(role !== 'crew'\)/if (false)/"

mutate "a missing service key falls back to a weaker check" \
  src/app/api/crew/media/route.ts \
  's/if \(!admin\) return NextResponse\.json/if (false) return NextResponse.json/'

echo ""
echo "=== 4. storage privacy ==="

mutate "the crew-media bucket is made public" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  "s/'crew-media', 'crew-media', false/'crew-media', 'crew-media', true/"

mutate "a replay no longer re-asserts private" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  's/set public            = false,/set file_size_limit = excluded.file_size_limit,/'

mutate "the bucket size ceiling is removed" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  's/false, 52428800,/false, null,/'

mutate "crew media resolves a permanent public URL instead of signing" \
  src/lib/crewMedia.ts \
  's/createSignedUrl\(path, seconds\)/getPublicUrl(path)/'

mutate "the signed URL is given a one-year life" \
  src/app/api/crew/media/route.ts \
  's/SIGNED_URL_SECONDS = 300/SIGNED_URL_SECONDS = 31536000/'

mutate "the storage path is echoed back to the client" \
  src/app/api/crew/media/route.ts \
  's/      id: m\.id,/      id: m.id,\n      storage_path: m.storage_path,/'

echo ""
echo "=== 5. the guard's own machinery ==="

mutate "the comment stripper is neutered (every absence check would pass)" \
  scripts/verify-scoped-notes.ts \
  "s/const stripSql = \(s: string\) => s\.replace\(\/--\[\^\\\\n\\\\r\]\*\/g, ''\)/const stripSql = (s: string) => (s+'')/"

mutate "the owner is no longer told which audience the quote note has" \
  src/components/quotes/QuoteBuilder.tsx \
  's/label=\{AUDIENCE_COPY\.customer\.label\} hint=\{AUDIENCE_COPY\.customer\.help\}/label="Notes"/'

mutate "a per-row visibility switch is added to crew_media" \
  supabase/RUN-2026-08-11-scoped-notes-crew-media.sql \
  's/  caption       text,/  caption       text,\n  visibility    text default \x27crew\x27,/'

restore
echo ""
echo "─────────────────────────────────────────────"
echo "  caught: $PASS    escaped or inapplicable: $FAIL"
if [ "$FAIL" -eq 0 ]; then echo "  ✅ every breach turns the guard red"; exit 0
else echo "  ❌ $FAIL case(s) did not turn the guard red"; exit 1; fi
