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
    from: "    .eq('user_id', worker.employerId)",
    to: "    // .eq('user_id', worker.employerId)  [mutated]",
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
    from: "  if (error) return { ok: false, denial: 'lookup-failed' }\n  const row = data",
    to: "  const row = data",
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
    from: '  const auth = await authorizeWorkerVisit(admin, user.id, jobId)',
    to: '  const auth = { ok: true, worker: t, visit: { jobId, employerId: t.employerId } } as any',
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
  if (!original.includes(m.from)) {
    console.error(`  ! SKIPPED (anchor not found): ${m.name}\n      in ${m.file}`)
    survivors.push(`${m.name} — anchor missing, mutation never applied`)
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
