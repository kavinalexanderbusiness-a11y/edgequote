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
import { format } from 'date-fns'
import { parseScheduleDate } from '../src/lib/scheduleDate'

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
  /setCursor\(c => dir === 1 \? addDays\(c \?\? cursor, 1\) : subDays\(c \?\? cursor, 1\)\)/.test(page),
  'navigate(1) in day view is now the one-tap route to tomorrow')
check('the ?d=YYYY-MM-DD deep link still lands on its day',
  /const dayParam = searchParams\.get\('d'\)/.test(page)
  && /const date = parseScheduleDate\(dayParam\)\s+if \(date\) setCursor\(date\)/.test(page))

console.log('\n═══ Month / Week untouched ═══')
check('the three views still switch',
  /const viewButtons: CalendarView\[\] = \['month', 'week', 'day'\]/.test(page))
check('month and week navigation still steps their own periods',
  /if \(view === 'month'\) setCursor\(c => dir === 1 \? addMonths\(c \?\? cursor, 1\) : subMonths\(c \?\? cursor, 1\)\)/.test(page)
  && /else if \(view === 'week'\) setCursor\(c => dir === 1 \? addWeeks\(c \?\? cursor, 1\) : subWeeks\(c \?\? cursor, 1\)\)/.test(page))

console.log('\n═══ Date links cannot crash the calendar ═══')
for (const value of [null, '', '2026-02-30', '2026-13-05', '2026-00-10', '2026-09-00', '2026-04-31', '2026-02-29', '2026-9-5', '2026-09-05T00:00:00']) {
  check(`invalid date ${JSON.stringify(value)} is ignored`, parseScheduleDate(value) === null)
}
for (const value of ['2026-09-05', '2028-02-29', '2026-12-31', '2027-01-01']) {
  const date = parseScheduleDate(value)
  check(`valid date ${value} survives unchanged`, date !== null && format(date, 'yyyy-MM-dd') === value)
}

console.log('\n═══ Today belongs to the business ═══')
check('the initial selection accepts a valid day link, otherwise follows tenant Today',
  /useState<Date \| null>\(\(\) => parseScheduleDate\(dayParam\)\)/.test(page)
  && /selectedCursor \?\? parseISO\(tenantToday \+ 'T00:00:00'\)/.test(page))
check('Today clears the explicit selection and resumes following the tenant day',
  /onClick=\{\(\) => setCursor\(null\)\}>Today<\/Button>/.test(page))
check('an unknown tenant timezone shows loading before any schedule controls',
  /ready: tenantTimeReady/.test(page)
  && /if \(!tenantTimeReady\) return <SkeletonRows label="Loading schedule…" \/>/.test(page))
check('the calendar receives the same tenant day as the board', /todayISO=\{tenantToday\}/.test(page))

// Execute only the two readiness-sensitive effect bodies with fake timers,
// DOM and setters. A slow timezone read must not consume navigation intent or
// exhaust the scroll timeout while the target is hidden behind the skeleton.
function effectAfter(marker: string) {
  const start = page.indexOf(marker)
  const match = start < 0 ? null : page.slice(start).match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\)/)
  if (!match) throw new Error(`Missing schedule effect: ${marker}`)
  return { body: match[1], dependencies: match[2] }
}
const panelEffect = effectAfter("const panelParam = searchParams.get('panel')")
const runPanel = new Function('tenantTimeReady', 'panelParam', 'editing', 'readJobPanel', 'window', 'document', 'jobPanelAnchorId', 'scrollBehavior', panelEffect.body)
let timer: (() => void) | null = null
let scrolls = 0
const fakeWindow = {
  setInterval(callback: () => void) { timer = callback; return 1 },
  clearInterval() { timer = null },
}
const fakeDocument = { getElementById: () => ({ scrollIntoView() { scrolls++ } }) }
const panelArgs = ['time', { id: 'synthetic-visit' }, (value: string) => value, fakeWindow, fakeDocument, (value: string) => value, () => 'auto']
runPanel(false, ...panelArgs)
check('a slow timezone read starts no panel timeout while the target is hidden', timer === null && scrolls === 0)
const cleanupPanel = runPanel(true, ...panelArgs)
if (timer) (timer as () => void)()
check('the panel scroll starts when timezone loading finishes', scrolls === 1)
cleanupPanel?.()
check('timezone readiness retriggers the panel effect', /\btenantTimeReady\b/.test(panelEffect.dependencies))

const estimateEffect = effectAfter('const estimateDeepLinkUsed = useRef(false)')
const runEstimate = new Function('tenantTimeReady', 'estimateParam', 'estimateDeepLinkUsed', 'setEstimateDialog', 'dayISO', estimateEffect.body)
const estimateUsed = { current: false }
const openedEstimates: { date: string }[] = []
const openEstimate = (value: { date: string }) => openedEstimates.push(value)
runEstimate(false, 'new', estimateUsed, openEstimate, '2026-09-05')
check('a slow timezone read does not consume estimate intent using the fallback day', !estimateUsed.current && openedEstimates.length === 0)
runEstimate(true, 'new', estimateUsed, openEstimate, '2026-09-06')
runEstimate(true, 'new', estimateUsed, openEstimate, '2026-09-07')
check('the estimate opens once on the resolved business day and stays there', openedEstimates.length === 1 && openedEstimates[0].date === '2026-09-06')
check('timezone readiness retriggers estimate intent', /\btenantTimeReady\b/.test(estimateEffect.dependencies))

// Render the actual calendar with empty synthetic data. No client effects or
// network calls run. This repo's JSX-preserve TS runner needs React in scope,
// as in verify:mobile-shell.
const React = require('react') as typeof import('react')
;(globalThis as Record<string, unknown>).React = React
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const { Calendar } = require('../src/components/schedule/Calendar') as typeof import('../src/components/schedule/Calendar')
const calendarCursor = parseScheduleDate('2032-02-28')!
for (const view of ['month', 'week'] as const) {
  const render = (todayISO: string | null) => renderToStaticMarkup(React.createElement(Calendar, {
    view, cursor: calendarCursor, todayISO, jobs: [], onSelectDay: () => {}, onSelectJob: () => {},
  }))
  const html = render('2032-02-28')
  check(`${view}: only the supplied business day is marked Today`,
    html.includes('data-date="2032-02-28" aria-current="date"')
    && (html.match(/aria-current="date"/g) ?? []).length === 1)
  const currentCell = html.split('data-date="2032-02-28"')[1]?.split('data-date=')[0] ?? ''
  check(`${view}: the business day also has its visual highlight`, currentCell.includes('bg-accent text-black'))
  check(`${view}: no guessed Today appears before the timezone is ready`, !render(null).includes('aria-current="date"'))
}

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
