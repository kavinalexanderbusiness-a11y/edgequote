// ── Mutation testing for verify:worker-access ────────────────────────────────
//
// A guard that cannot fail is decoration. This breaks each load-bearing rule ON
// PURPOSE, one at a time, and requires verify:worker-access to go RED for every
// one. A mutation that survives names a rule nobody is actually checking.
//
// The mutations are chosen to be the mistakes a real change would make — a
// predicate dropped during a refactor, a null case "simplified", a check moved
// to the client — not nonsense that would fail to compile.
//
// ⚠️⚠️ COMMIT FIRST. This rewrites source files and restores them from disk
// afterwards; an interrupted run (or a crash) leaves the last mutation in the
// tree. If the work is not committed, a restore can destroy it — that has
// happened in this repo before.
//
// Usage:  node scripts/mutate-worker-access.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const LIB = join('src', 'lib', 'workerAccess.ts')
const COMPLETE = join('src', 'app', 'api', 'crew', 'complete', 'route.ts')
const MEDIA = join('src', 'app', 'api', 'crew', 'media', 'route.ts')
const PHOTOS = join('src', 'app', 'api', 'crew', 'photos', 'route.ts')
const MIGRATION = join('supabase', 'migrations', '20260817060000_worker_access_v1.sql')

/** Each mutation: what rule it attacks, the file, and the edit. */
const MUTATIONS = [
  {
    name: 'TENANT predicate removed from the visit lookup',
    why: 'without it a job id from another business resolves',
    file: LIB,
    // Anchored on the comment above it, because the bare call also appears in
    // assignedVisitFilter's docstring example.
    from: "    // The tenant predicate. From the roster row, never from the request.\n    .eq('user_id', worker.employerId)",
    to: "    // [mutated] tenant predicate removed",
  },
  {
    name: 'ASSIGNMENT predicate removed from the door',
    why: 'without it any visit in the tenant is reachable',
    file: LIB,
    from: "  if (!workerCoversVisit(worker, visit)) return { ok: false, denial: 'not-assigned' }",
    to: "  // [mutated] coverage no longer checked",
  },
  {
    name: 'coverage widened so NULL matches NULL',
    why: 'a crewless worker would inherit every unassigned visit in the book',
    file: LIB,
    from: '  const byCrew = visit.crewId != null && worker.crewId != null && visit.crewId === worker.crewId',
    to: '  const byCrew = visit.crewId === worker.crewId',
  },
  {
    name: 'by-name coverage dropped (back to the pre-S65 model)',
    why: 'the person S65 exists to support loses access to their own work',
    file: LIB,
    from: '  const byName = visit.technicianId != null && visit.technicianId === worker.technicianId',
    to: '  const byName = false',
  },
  {
    name: 'DISABLED check removed from the identity resolver',
    why: 'a switched-off worker keeps working until their token expires',
    file: LIB,
    from: "    .eq('is_active', true)\n    .is('archived_at', null)",
    to: "    // [mutated] roster switches no longer read",
  },
  {
    name: 'ARCHIVED check removed from the identity resolver',
    why: 'an archived worker is still a worker',
    file: LIB,
    from: "    .is('archived_at', null)",
    to: "    // [mutated] archived no longer excluded",
  },
  {
    name: 'the crewless filter emits crew_id.is.null',
    why: 'the set-level door then matches every UNASSIGNED visit in the tenant',
    file: LIB,
    from: '  if (worker.crewId != null) clauses.push(`crew_id.eq.${worker.crewId}`)',
    to: '  clauses.push(worker.crewId != null ? `crew_id.eq.${worker.crewId}` : `crew_id.is.null`)',
  },
  {
    name: 'a failed lookup falls through instead of refusing',
    why: 'a dead database would open every door instead of closing them',
    file: LIB,
    from: "  // A failed read is not an absent worker. Say so, and refuse.\n  if (error) return { ok: false, denial: 'lookup-failed' }",
    to: "  // [mutated] failed read no longer refuses",
  },
  {
    name: 'not-assigned answers 403 instead of 404',
    why: 'a 403 beside a 404 turns any id field into an existence oracle',
    file: LIB,
    from: "  'not-assigned': 404,",
    to: "  'not-assigned': 403,",
  },
  {
    name: 'a refusal message leaks database vocabulary',
    why: 'the worker gets internals instead of a sentence',
    file: LIB,
    from: "  'not-assigned': 'Not available — this isn’t one of your visits.',",
    to: "  'not-assigned': 'jobs row not found for technician_id / crew_id.',",
  },
  {
    name: 'cancelled becomes a worker-settable status',
    why: 'a worker could call off booked work, which is a money decision',
    file: LIB,
    from: "export const WORKER_VISIT_STATUSES = ['scheduled', 'in_progress', 'completed'] as const",
    to: "export const WORKER_VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const",
  },
  {
    name: 'the completion door keeps its own crew-only gate again',
    why: 'the exact pre-S66 regression: a by-name assignee cannot finish',
    file: COMPLETE,
    from: '  const auth = await authorizeWorkerVisit(admin, user.id, jobId)',
    to: '  const auth = await authorizeWorkerVisit(admin, user.id, jobId)\n  // [mutated] rival gate\n  const t = { crew_id: null }\n  if (!t.crew_id) { /* pre-S66 shape */ }',
    expectSource: '!t.crew_id',
  },
  {
    name: 'the media door stops authorising',
    why: 'reading work instructions would need only a job id',
    file: MEDIA,
    // The POST door specifically — GET has an identically-spelled call.
    from: "  // ⭐ THE canonical door — active worker, this worker's tenant, then crew OR\n  // by-name assignment. One call, the same answer every other worker door gives.\n  const auth = await authorizeWorkerVisit(admin, user.id, jobId)",
    to: '  const auth = { ok: true, worker: t, visit: { jobId, employerId: t.employerId } } as any',
  },
  {
    name: 'a crew STORAGE policy is added to the private bucket',
    why: 'per-object policies re-derive assignment by parsing a path — a fifth copy, and the one that lets a worker enumerate objects',
    file: MIGRATION,
    from: '-- ── 1. crew_job_forms — reading this visit’s checklists ──────────────────────',
    to: `create policy "crew-media: crew reads" on storage."objects" as permissive for select to public
  using ((bucket_id = 'crew-media'::text) AND (public.crew_employer() is not null));
-- ── 1. crew_job_forms — reading this visit’s checklists ──────────────────────`,
  },
  {
    name: 'the photos door stops authorising',
    why: 'proof could be uploaded onto anyone’s visit',
    file: PHOTOS,
    from: '  const auth = await authorizeWorkerVisit(admin, user.id, jobId)',
    to: '  const auth = { ok: true, worker: { employerId: null } } as any',
  },
  {
    name: 'the SQL doors go back to the crew-only predicate',
    why: 'the database half would disagree with the server half again',
    file: MIGRATION,
    from: '    and public.crew_assignment_covers(crew_id, technician_id, v_crew, v_tech);\n  if not found then return null; end if;',
    to: '    and crew_id = v_crew;\n  if not found then return null; end if;',
  },
  {
    name: 'ensure_job_forms mints for any worker at the employer',
    why: 'an unassigned worker would materialise another crew’s checklist',
    file: MIGRATION,
    from: '       or not public.crew_assignment_covers(v_job.crew_id, v_job.technician_id, v_crew, v_tech) then',
    to: '       or false then',
  },
]

const run = () => {
  try {
    execSync('npx tsx scripts/verify-worker-access.ts', { stdio: 'pipe' })
    return 'GREEN'
  } catch {
    return 'RED'
  }
}

console.log('\n══ mutation testing: verify:worker-access ═════════════════════════════')
console.log('Baseline (unmutated) must be GREEN before any mutation means anything.\n')

const baseline = run()
if (baseline !== 'GREEN') {
  console.error('✗ baseline is RED — fix the guard before mutation testing.')
  process.exit(1)
}
console.log('  ✓ baseline GREEN\n')

let caught = 0, survived = 0
const survivors = []

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  const occurrences = original.split(m.from).length - 1
  if (occurrences === 0) {
    console.error(`  ! SKIPPED (anchor not found): ${m.name}\n      in ${m.file}`)
    survivors.push(`${m.name} — anchor missing, mutation never applied`)
    survived++
    continue
  }
  // ⚠️⚠️ AN AMBIGUOUS ANCHOR IS A SILENT NO-OP. String.replace takes the FIRST
  // match, and a doc comment that quotes the code it documents matches too — so
  // the "mutation" edits a comment, the guard stays green, and the survivor is
  // blamed on the guard rather than on this file. That happened: the tenant
  // predicate's anchor also appeared in the example inside assignedVisitFilter's
  // docstring. Anchors must be unique, and this refuses to pretend otherwise.
  if (occurrences > 1) {
    console.error(`  ! AMBIGUOUS ANCHOR (${occurrences}×): ${m.name}\n      in ${m.file} — narrow it`)
    survivors.push(`${m.name} — anchor matched ${occurrences} places, mutation unreliable`)
    survived++
    continue
  }
  writeFileSync(m.file, original.replace(m.from, m.to))
  let result
  try {
    result = run()
  } finally {
    writeFileSync(m.file, original)   // always restore, even if the run throws
  }
  if (result === 'RED') {
    caught++
    console.log(`  ✓ caught: ${m.name}`)
  } else {
    survived++
    survivors.push(`${m.name} — ${m.why}`)
    console.error(`  ✗ SURVIVED: ${m.name}\n      ${m.why}`)
  }
}

// Prove the tree is exactly as we found it.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
console.log(`\n── ${caught} caught, ${survived} survived ──`)
console.log(dirty ? `⚠️ working tree not clean after restore:\n${dirty}` : '✓ working tree restored clean')

if (survivors.length) {
  console.error('\nUnchecked rules:')
  for (const s of survivors) console.error(`  · ${s}`)
  process.exit(1)
}
