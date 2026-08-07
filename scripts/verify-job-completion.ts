// ── Verify: a completed visit is stamped, once, by one engine ────────────────
//   npm run verify:job-completion
//
// WHY THIS SCRIPT EXISTS
// "The job is done" is written by FOUR different doors: the field bar / day-card
// Complete button, the calendar's one-tap Done, the Day Ops quick-edit status
// dropdown, the full job form — plus the dispatch board's own check-out. Each
// one hand-composed the row it wrote, and they drifted:
//
//   • the quick-edit dropdown and the job form set `status = 'completed'` and
//     nothing else. No completed_at. So lib/dispatchOps' activity feed (which
//     emits a "completed" event only when completed_at is set) never showed the
//     completion to the manager, the customer portal showed no worked time,
//     lib/timeline re-dated the completion to whenever the row was last edited,
//     and the job.completed webhook shipped `completed_at: null` to every
//     connected integration. Production carried 7 of 72 completed visits like
//     this — ~10% of all completions, invisible.
//
//   • lib/jobStatus' completeVisit (the dispatch board's check-out) OVERWROTE
//     actual_minutes instead of accumulating. A visit continued onto another day
//     banks that session's minutes and clears started_at, so completing it from
//     the board silently destroyed the first day's hours — the number
//     profitability, route learning and pricing calibration all read.
//
// None of that fails tsc or `next build`: every one is a valid patch of the
// wrong shape. So the shape is asserted here — the derivation as behaviour, and
// the "only one engine writes it" rule over the real source.

import { completionPatch } from '../src/lib/jobStatus'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

// A fixed clock: every expectation below is exact, not approximate.
const NOW = '2026-08-07T17:30:00.000Z'
const minsBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()

// ── 1. The stamp ─────────────────────────────────────────────────────────────
console.log('\n═══ completionPatch — what "completed" writes ═══')

eq('a checked-in visit records status, when it finished, and time on site',
  completionPatch({ started_at: minsBefore(90), actual_minutes: null }, { now: NOW }),
  { status: 'completed', completed_at: NOW, actual_minutes: 90 })

// THE regression that shipped in completeVisit: this returned 45, throwing away
// the three hours already banked on the first day.
eq('a visit continued onto another day ADDS the final session to the banked time',
  completionPatch({ started_at: minsBefore(45), actual_minutes: 180 }, { now: NOW }),
  { status: 'completed', completed_at: NOW, actual_minutes: 225 })

// Completing without ever checking in tracks no time — but "no time tracked" is
// null, never 0. A fabricated zero reads downstream as a visit that took no
// labour at all, which is a 100%-margin job in every profitability lens.
eq('completing with no check-in leaves actual_minutes unknown, not zero',
  completionPatch({ started_at: null, actual_minutes: null }, { now: NOW }),
  { status: 'completed', completed_at: NOW, actual_minutes: null })

eq('completing with no check-in keeps time banked by an earlier session',
  completionPatch({ started_at: null, actual_minutes: 120 }, { now: NOW }),
  { status: 'completed', completed_at: NOW, actual_minutes: 120 })

eq('a figure the owner typed into the job form outranks the derived one',
  completionPatch({ started_at: minsBefore(90), actual_minutes: null }, { now: NOW, actualMinutes: 50 }),
  { status: 'completed', completed_at: NOW, actual_minutes: 50 })

// The form seeds that field from `job.actual_minutes || 0`, so a blank box is a
// 0 — "not stated", not "it took no time". It must not beat the clock.
eq('a blank "actual" box falls back to the derived time',
  completionPatch({ started_at: minsBefore(30), actual_minutes: null }, { now: NOW, actualMinutes: 0 }),
  { status: 'completed', completed_at: NOW, actual_minutes: 30 })

// completed_at is the field whose absence caused the bug — it can never be
// optional, whatever the other inputs are.
const alwaysStamped = [
  completionPatch({ started_at: null, actual_minutes: null }),
  completionPatch({ started_at: minsBefore(5), actual_minutes: null }),
  completionPatch({ started_at: null, actual_minutes: 10 }, { actualMinutes: 99 }),
]
check('every completion carries a real completed_at timestamp',
  alwaysStamped.every(p => typeof p.completed_at === 'string' && !Number.isNaN(Date.parse(p.completed_at))),
  `got ${JSON.stringify(alwaysStamped.map(p => p.completed_at))}`)
check('every completion carries status "completed"',
  alwaysStamped.every(p => p.status === 'completed'), 'status must be the literal "completed"')

// A started_at AHEAD of the clock (a device with a skewed time, a row edited by
// hand) must never subtract from the total. minutesBetween floors at 1, so the
// session adds a minute rather than eating three hours of banked work.
eq('a check-in stamped in the future cannot reduce banked time',
  completionPatch({ started_at: '2026-08-07T18:00:00.000Z', actual_minutes: 180 }, { now: NOW }),
  { status: 'completed', completed_at: NOW, actual_minutes: 181 })

// ── 2. One engine writes it ──────────────────────────────────────────────────
// The behaviour above is only worth anything if every door goes through it. A
// surface that hand-writes `status: 'completed'` has, by construction, skipped
// the stamp — that is exactly how the two silent doors were born.
console.log('\n═══ Only lib/jobStatus composes a completed row ═══')

const SRC = join(process.cwd(), 'src')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, '/')
const files = walk(SRC).map(f => ({ path: rel(f), text: readFileSync(f, 'utf8') }))

check('the source scan found the app', files.length > 200, `only ${files.length} files walked — the walk is broken, not the code`)

// `status: 'completed'` in KEY position (an object being built), not a
// comparison. Comparisons (=== 'completed') are how surfaces READ status and are
// none of this guard's business.
const WRITES_COMPLETED = /\bstatus:\s*['"]completed['"]/

// Allowed to hold the literal, each for a stated reason. ⚠️ Do not add a surface
// here to silence a failure — route it through completionPatch instead.
const ALLOWED: Record<string, string> = {
  'lib/jobStatus.ts': 'THE stamp — this is the one definition',
  'lib/integrations/events.ts': 'a documentation sample payload for the job.completed event, never written to a row',
}

const offenders = files.filter(f => WRITES_COMPLETED.test(f.text) && !(f.path in ALLOWED))
for (const o of offenders) {
  const line = o.text.split('\n').findIndex(l => WRITES_COMPLETED.test(l)) + 1
  fail(`${o.path}:${line} hand-writes a completed status`,
    'compose it with completionPatch() from lib/jobStatus — a status without completed_at is a completion the dispatch feed, the portal and the job.completed webhook never see')
}
if (!offenders.length) ok('no surface hand-writes a completed status')

// An allowlist entry whose file stopped holding the literal is dead weight that
// could start shielding a real offender in the same file later.
for (const [path, why] of Object.entries(ALLOWED)) {
  const f = files.find(x => x.path === path)
  if (!f) fail(`stale allowlist entry: ${path}`, `${why} — but the file no longer exists`)
  else if (!WRITES_COMPLETED.test(f.text)) fail(`stale allowlist entry: ${path}`, 'it no longer writes a completed status — delete the ALLOWED entry')
}

// ── 3. Every door is wired to it ─────────────────────────────────────────────
console.log('\n═══ Every completion door calls the stamp ═══')

// file → how many distinct completion transitions it owns.
const DOORS: { path: string; calls: number; what: string }[] = [
  { path: 'lib/jobStatus.ts', calls: 1, what: 'completeVisit — the dispatch board check-out' },
  { path: 'app/dashboard/schedule/page.tsx', calls: 3, what: 'the Complete button, the quick-edit dropdown, the job form' },
]
for (const d of DOORS) {
  const f = files.find(x => x.path === d.path)
  if (!f) { fail(`${d.path} is missing`, d.what); continue }
  const n = (f.text.match(/completionPatch\s*\(/g) || []).length
  check(`${d.path} — ${d.what}`, n >= d.calls,
    `expected at least ${d.calls} completionPatch( call site${d.calls === 1 ? '' : 's'}, found ${n}; a door that stopped calling it writes a status with no timestamp`)
}

// The two doors whose status comes from a PICKER (a dropdown, a form select)
// can't be spotted by a literal — they pass a variable. They are only safe
// because each detects the transition and merges the stamp, so pin that shape.
const page = files.find(f => f.path === 'app/dashboard/schedule/page.tsx')
if (page) {
  check('the quick-edit dropdown detects the completed transition',
    /const completing = patch\.status === 'completed' && job\.status !== 'completed'/.test(page.text),
    'quickSaveJob must branch on the transition before merging the stamp')
  check('the job form detects the completed transition',
    /const completing = values\.status === 'completed' && job\.status !== 'completed'/.test(page.text),
    'applyFieldEdits must branch on the transition before merging the stamp')
  // …and applies the stamp ONLY on that transition. Stamping every save would
  // re-date old completions whenever anyone edits the row — the precise failure
  // lib/timeline reads completed_at (rather than updated_at) to avoid.
  check('the quick-edit dropdown stamps only on the transition',
    /\.\.\.\(completing \? completionPatch\(job\) : \{\}\)/.test(page.text),
    'quickSaveJob must merge the stamp behind the `completing` branch, not on every save')
  check('the job form stamps only on the transition',
    /completing\s*\n?\s*\?\s*completionPatch\(job, \{ actualMinutes: stated \}\)/.test(page.text),
    'applyFieldEdits must pick the stamp only when the visit is newly completed')
}

// ── 4. Un-completing still clears it ─────────────────────────────────────────
// The inverse was always right and must stay right: a reopened visit that keeps
// its completed_at is invisible to the un-invoiced queue — un-billable and
// un-findable at the same time.
console.log('\n═══ Un-completing clears the stamp ═══')
if (page) {
  check('reopening a visit clears completed_at',
    (page.text.match(/completed_at:\s*null/g) || []).length >= 2,
    'both un-complete doors (quick-edit dropdown, job form) must clear completed_at')
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:job-completion — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:job-completion — one stamp, every door, nothing un-timed\n')
