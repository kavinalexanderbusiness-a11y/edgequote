// ── Verify: the day header lost its Tomorrow button, and nothing else ────────
//   npm run verify:day-view-tomorrow
//
// Session 112 (owner-directed): the named "Tomorrow" quick-action left the
// Schedule day toolbar — the owner wants the header simpler. The removal is
// only honest while the CAPABILITY survives it, so this pins both halves:
// no button labelled Tomorrow in the schedule toolbar, and every other way of
// reaching tomorrow (next-period chevron, ?d= deep link, month/week taps)
// still wired exactly as before.
//
// ⛔ RainDelayCenter's "Tomorrow" is NOT this button — it is a date-choice
// LABEL inside the rain-reschedule options (today/tomorrow/specific date), a
// different feature. This guard asserts it SURVIVES, so nobody sweeps it in a
// later "clean up the word Tomorrow" pass.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => c ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const page = read('src/app/dashboard/schedule/page.tsx')

console.log('\n═══ The button is gone ═══')
check('no button in the schedule page is labelled Tomorrow',
  !/>\s*Tomorrow\s*<\/Button>/.test(page),
  'the owner asked for the simpler header — if this is deliberate revival, retire this guard with the reasoning')

console.log('\n═══ The capability is not ═══')
check('the next-period chevron survives, with its accessible name',
  /aria-label="Next period" onClick=\{\(\) => navigate\(1\)\}/.test(page),
  'removing the shortcut must never take the arrow with it')
check('Today survives beside it',
  />\s*Today\s*<\/Button>/.test(page))
check('day-view next-period still steps one DAY',
  /setCursor\(c => dir === 1 \? addDays\(c, 1\) : subDays\(c, 1\)\)/.test(page),
  'navigate(1) in day view is now the one-tap route to tomorrow')
check('the ?d=YYYY-MM-DD deep link still lands on its day',
  /const dayParam = searchParams\.get\('d'\)/.test(page)
  && /if \(!dayParam \|\| !\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(dayParam\)\) return/.test(page)
  && /setCursor\(parseISO\(dayParam \+ 'T00:00:00'\)\)/.test(page))

console.log('\n═══ Month / Week untouched ═══')
check('the three views still switch',
  /const viewButtons: CalendarView\[\] = \['month', 'week', 'day'\]/.test(page))
check('month and week navigation is byte-what-it-was',
  /if \(view === 'month'\) setCursor\(c => dir === 1 \? addMonths\(c, 1\) : subMonths\(c, 1\)\)/.test(page)
  && /else if \(view === 'week'\) setCursor\(c => dir === 1 \? addWeeks\(c, 1\) : subWeeks\(c, 1\)\)/.test(page))

console.log('\n═══ The OTHER Tomorrow is a different feature, and stays ═══')
const rain = read('src/components/schedule/RainDelayCenter.tsx')
check('RainDelayCenter still offers Tomorrow as a reschedule date label',
  /date === tomorrow \? 'Tomorrow'/.test(rain),
  'that label is a rain-reschedule date choice, not day navigation — it was never in scope')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:day-view-tomorrow — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:day-view-tomorrow — the button is gone; every road to tomorrow is not\n')
