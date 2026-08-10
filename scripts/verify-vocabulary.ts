// ── Verify: one word per thing, and "jobs" leads somewhere ───────────────────
//   npm run verify:vocabulary
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote called the same thing a job, a visit and a stop on adjacent screens
// — and the Schedule page used both "job" and "visit" for one concept in the
// same viewport. The cause is structural rather than careless: the table named
// `jobs` holds VISITS (231 rows across 14 recurring series when this was
// written), so any copy authored straight off a variable name says the wrong
// word. That pressure does not go away, which is why the rule is pinned here.
//
// THE RULE (lib/vocabulary):
//   Job    — the work for a customer; one-off or an ongoing plan. CREATING and
//            IDENTIFYING it says "job" (Add job, Job title, Edit job).
//   Visit  — one scheduled occurrence. ACTING ON ONE says "visit" (complete,
//            move, reschedule, price, past-due, this-one-only).
//   Stop   — a visit's place in a day's route. Dispatch and the day board only.

import { visits, stops, jobs, scheduleSubtitle } from '../src/lib/vocabulary'
import { FEATURE_MODULES } from '../src/lib/modules'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── 1. The words pluralise ───────────────────────────────────────────────────
console.log('\n═══ The words ═══')
eq('one visit', visits(1), '1 visit')
eq('many visits', visits(3), '3 visits')
eq('one stop', stops(1), '1 stop')
eq('one job', jobs(1), '1 job')
check('the schedule subtitle names BOTH words',
  /visit/.test(scheduleSubtitle(12)) && /job/.test(scheduleSubtitle(12)),
  `it is the answer to "where do my jobs live?", so it must teach the relationship — got "${scheduleSubtitle(12)}"`)
check('…and counts visits, not jobs', scheduleSubtitle(12).startsWith('12 visits'),
  'the calendar holds occurrences; calling 231 of them "jobs" is what taught the wrong model')

// ── 2. Occurrence language on the Schedule surfaces ──────────────────────────
// Each phrase below acts on ONE scheduled occurrence. They said "job" while the
// very same screens said "visit" elsewhere. Pinned individually so a re-word
// cannot quietly reintroduce the mix.
console.log('\n═══ Acting on one occurrence says "visit" ═══')
const MUST_NOT_SAY_JOB: [string, string][] = [
  ['src/app/dashboard/schedule/page.tsx', 'move jobs (weather'],
  ['src/components/schedule/BestDaySuggestions.tsx', 'nearby jobs'],
  ['src/components/schedule/DayOpsPanel.tsx', 'property to this job'],
  ['src/components/schedule/JobAddons.tsx', 'Total job value'],
  ['src/components/schedule/OptimizeSchedule.tsx', 'billed jobs'],
  ['src/components/schedule/RainDelayCenter.tsx', 'Why are jobs moving'],
  ['src/components/schedule/RainDelayCenter.tsx', 'Choose jobs to move'],
  ['src/components/schedule/RainDelayCenter.tsx', 'billed jobs'],
  ['src/components/schedule/WeatherRainCard.tsx', 'movable jobs'],
]
for (const [file, phrase] of MUST_NOT_SAY_JOB) {
  const t = read(file)
  check(`${file.split('/').pop()} — no "${phrase}"`, !t.includes(phrase),
    'this acts on one scheduled occurrence, so it reads "visit"')
}

// The counterpart: those files DO talk about visits now.
for (const f of ['src/components/schedule/BestDaySuggestions.tsx',
                 'src/components/schedule/RainDelayCenter.tsx',
                 'src/components/schedule/WeatherRainCard.tsx']) {
  check(`${f.split('/').pop()} speaks of visits`, /\bvisits?\b/i.test(read(f)))
}

// ⭐ CREATION language is deliberately still "job" — you create a job, which may
// then recur into many visits. Renaming these would be the opposite error.
const day = read('src/components/schedule/DayOpsPanel.tsx')
const form = read('src/components/schedule/JobForm.tsx')
check('creating still says "job"', day.includes('Add job') && form.includes('Job Title'),
  'a one-off job IS its only visit; "Add visit" would misdescribe creating a recurring plan')

// ── 3. "Stop" stays route-only ───────────────────────────────────────────────
console.log('\n═══ "Stop" means a place in a route ═══')
// Crew Mode and the day board order stops; the customer-facing portal never
// should — a customer has a visit, not a stop on somebody's route.
for (const f of ['src/app/portal/[token]/components/VisitsTab.tsx',
                 'src/app/portal/[token]/components/HomeTab.tsx']) {
  const t = read(f)
  check(`${f.split('/').pop()} says visit, never stop`,
    !/>[^<>{}\n]*\bstops?\b[^<>{}\n]*</i.test(t),
    'a customer has a visit; "stop" is our routing word, not theirs')
}
check('the day board still orders stops',
  /\bstops?\b/i.test(read('src/components/schedule/DayOpsPanel.tsx')),
  'route position is genuinely a different concept — do not flatten it into "visit"')

// ── 4. "Where do my jobs live?" has an answer ────────────────────────────────
// The command palette filters on label + keywords. Before keywords existed,
// typing "jobs" matched NOTHING: no label contains it.
console.log('\n═══ Owner words find the page ═══')
const find = (q: string) => FEATURE_MODULES
  .filter(m => m.label.toLowerCase().includes(q) || (m.keywords ?? '').toLowerCase().includes(q))
  .map(m => m.label)
for (const [q, expected] of [['jobs', 'Schedule'], ['visits', 'Schedule'], ['payroll', 'Workforce'],
                             ['estimates', 'Quotes'], ['owed', 'Invoices'], ['leads', 'Messages'],
                             ['stops', 'Dispatch'], ['clients', 'Customers']] as const) {
  check(`"${q}" finds ${expected}`, find(q).includes(expected), `found: ${find(q).join(', ') || 'NOTHING'}`)
}

const palette = read('src/components/command/CommandPalette.tsx')
check('the palette reads keywords from the registry',
  /keywords: m\.keywords/.test(palette) && /keywords: n\.keywords/.test(palette),
  'a second hand-kept keyword list would drift from the registry')

// ── 5. The rule is written down where the next person will look ──────────────
console.log('\n═══ The rule is documented ═══')
const vocab = read('src/lib/vocabulary.ts')
for (const word of ['Job', 'Visit', 'Stop']) {
  check(`lib/vocabulary defines ${word}`, new RegExp(`^//\\s+${word}\\s+—`, 'm').test(vocab))
}
check('…and records WHY the copy drifted',
  /table named `jobs` holds\s+\n?\/\/ VISITS|table named `jobs` holds VISITS/i.test(vocab),
  'the trap (a jobs row is a visit) is the reason this keeps happening — it has to be stated')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:vocabulary — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:vocabulary — job / visit / stop each mean one thing\n')
