// ── Verify: dashboard customization + the owner briefing ─────────────────────
//   npm run verify:dashboard-v2
//
// WHY THIS SCRIPT EXISTS
// Session 97 gave the dashboard two new movable parts, each with a way to lie:
//   · THE LAYOUT (lib/dashboard/layout) — a stored preference decides which
//     bands render and in what order. The rot shapes: a malformed/legacy value
//     (the revived dashboard_cards column holds the DEAD pre-019c24c shell's
//     ids in old rows) taking the page down or rendering ghosts; a stored
//     value smuggling the Needs-You card off the screen — which would remove
//     the one place a degraded load says "couldn't check everything"; a saved
//     layout silently forcing every future optional card ON (the append rule).
//   · THE BRIEFING (lib/dashboard/briefing) — linked facts under the greeting.
//     The rot shapes: a second derivation drifting from the engine that owns
//     the number (every figure here must be a canonical engine's, verbatim); a
//     failed source rendered as a calm zero (the false-all-clear shape); a
//     number whose door opens the wrong surface.
// This guard drives the REAL engines over fixed fixtures for every scenario,
// proves cross-engine door agreement by running BOTH engines, and pins the
// page/component wiring statically. Live halves are deliberately absent:
// both engines are pure, and the sources they compose have their own guards
// (verify:priority-queue, verify:owner-inbox, verify:day-plan…). Tenancy of
// the one new read (dashboard_cards) is pinned statically below; every other
// figure arrives through loadDashboard/loadInboxSources, whose per-read
// tenancy is already pinned by those guards.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DASHBOARD_CARDS, DEFAULT_DASHBOARD_LAYOUT, canStepCard, isDashboardCustomised,
  normalizeDashboardLayout, stepCard, toggleCardHidden, visibleDashboardCards,
  type DashboardLayout,
} from '../src/lib/dashboard/layout'
import { composeBriefing, type BriefingInput } from '../src/lib/dashboard/briefing'
import { computePriorities } from '../src/lib/dashboard/priorities'
import { planDay, type DayPlanWarning } from '../src/lib/dayPlan'
import { settingsToSeasons } from '../src/lib/seasons'
import { formatCurrency } from '../src/lib/utils'
import type { DayPlanRow, SourceResult } from '../src/lib/inbox'
import type { LeadResponseReport } from '../src/lib/leadResponse'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const TODAY = '2026-08-15'

// ── §1 The layout engine ─────────────────────────────────────────────────────
console.log('\n§1 layout — normalize, required card, forward-compat')

const ALL = DASHBOARD_CARDS.map(c => c.id)
check('registry ids are unique', new Set(ALL).size === ALL.length)
check('exactly one required card, and it is needsYou',
  DASHBOARD_CARDS.filter(c => c.required).map(c => c.id).join() === 'needsYou')
check('updates ships defaultOn:false (an existing dashboard must not grow a band unasked)',
  DASHBOARD_CARDS.find(c => c.id === 'updates')?.defaultOn === false)
eq('default order = registry order', DEFAULT_DASHBOARD_LAYOUT.order.join(), ALL.join())
eq('default hides exactly the defaultOn:false cards', DEFAULT_DASHBOARD_LAYOUT.hidden.join(), 'updates')

for (const [name, raw] of [
  ['null (no row / no column)', null],
  ['undefined', undefined],
  ['a string', 'money'],
  ['an array', ['money']],
  ['a number', 7],
  ['legacy shell ids (the dead pre-019c24c values)', { order: ['revenue-chart', 'kpi-tiles'], hidden: ['old-feed'] }],
  ['legacy with non-string members', { order: [1, null, {}], hidden: [false] }],
] as const) {
  const l = normalizeDashboardLayout(raw)
  check(`normalize(${name}) → the default composition`,
    l.order.join() === DEFAULT_DASHBOARD_LAYOUT.order.join()
    && l.hidden.join() === DEFAULT_DASHBOARD_LAYOUT.hidden.join())
}

{
  const l = normalizeDashboardLayout({ order: ['month', 'needsYou', 'money', 'today', 'review'], hidden: ['review'] })
  eq('a saved order is honored (missing ids appended after it)', l.order.join(), 'month,needsYou,money,today,review,updates')
  check('a saved hide is honored', l.hidden.includes('review'))
  check('updates, never mentioned by this save, is appended HIDDEN (defaultOn:false)', l.hidden.includes('updates'))
  eq('visible = order minus hidden', visibleDashboardCards(l).map(c => c.id).join(), 'month,needsYou,money,today')
}

{
  const l = normalizeDashboardLayout({ order: ['updates', 'money', 'needsYou', 'today', 'month', 'review'], hidden: [] })
  check('an EXPLICIT unhide of updates stands (mentioned in order, absent from hidden)',
    !l.hidden.includes('updates') && visibleDashboardCards(l).some(c => c.id === 'updates'))
}

{
  const l = normalizeDashboardLayout({ order: ['money', 'money', 'needsYou', 'ghost'], hidden: ['ghost'] })
  check('duplicates dedupe to first position, unknown ids drop', l.order.filter(id => id === 'money').length === 1 && !(l.order as string[]).includes('ghost'))
}

{
  const l = normalizeDashboardLayout({ order: ['money', 'today'], hidden: ['needsYou'] })
  check('needsYou cannot be hidden by a stored value', !l.hidden.includes('needsYou'))
  check('…so it is always visible', visibleDashboardCards(l).some(c => c.id === 'needsYou'))
  const toggled = toggleCardHidden(l, 'needsYou')
  check('toggleCardHidden refuses the required card', !toggled.hidden.includes('needsYou'))
}

{
  const base = normalizeDashboardLayout(null)
  const hidMoney = toggleCardHidden(base, 'money')
  check('toggle hides a normal card', hidMoney.hidden.includes('money'))
  check('toggle round-trips', !toggleCardHidden(hidMoney, 'money').hidden.includes('money'))

  // Stepping skips hidden cards: with money hidden, needsYou (visible index 0)
  // steps down past it to land after `today`.
  const stepped = stepCard(hidMoney, 'needsYou', 1)
  eq('stepCard moves among VISIBLE cards (hidden ones are skipped over)',
    visibleDashboardCards(stepped).map(c => c.id).join(), 'today,needsYou,month,review')
  check('canStepCard is false at the top edge', !canStepCard(base, 'money', -1))
  check('canStepCard is false at the bottom edge', !canStepCard(base, 'review', 1))
  check('stepCard on a hidden card is a no-op', stepCard(hidMoney, 'money', 1).order.join() === hidMoney.order.join())
  check('isCustomised: default false', !isDashboardCustomised(base))
  check('isCustomised: true after a hide', isDashboardCustomised(hidMoney))
  check('isCustomised: true after a reorder', isDashboardCustomised(stepped))
}

// ── §2 The briefing engine ───────────────────────────────────────────────────
console.log('\n§2 briefing — every figure an engine’s, every number a door, failure honest')

// Day fixtures go THROUGH planDay — the real engine judges; this guard never
// writes its own blocking verdicts (same discipline as verify:owner-inbox).
const overbookedDay = (date: string): DayPlanRow => {
  const p = planDay({
    stops: [1, 2, 3].map(n => ({ jobId: `j${n}`, durationMinutes: 240, crewSize: 1, status: 'scheduled', located: false })),
    startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
  })
  return { date, stops: p.stopCount, warnings: p.warnings }
}
check('fixture sanity: the overbooked day IS blocking by planDay’s own verdict',
  overbookedDay(TODAY).warnings.some(w => w.severity === 'blocking'))

const okDay = (date: string): DayPlanRow => {
  const p = planDay({
    stops: [{ jobId: 'j1', durationMinutes: 60, crewSize: 1, status: 'scheduled', located: false }],
    startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
  })
  return { date, stops: p.stopCount, warnings: p.warnings }
}

const briefing = (over: Partial<BriefingInput>) => composeBriefing({
  todayISO: TODAY,
  stopsToday: 0, revenueToday: 0,
  overdue: 0, overdueCount: 0,
  followupsDue: 0, requestsOpen: 0,
  dayPlan: { ok: true, rows: [] },
  ...over,
})

{
  // The spec's own example morning: 7 visits, 1 conflict, 2 follow-ups,
  // $1,240 overdue, 1 request.
  const b = briefing({
    stopsToday: 7, revenueToday: 840,
    overdue: 1240, overdueCount: 3,
    followupsDue: 2, requestsOpen: 1,
    dayPlan: { ok: true, rows: [okDay(TODAY), overbookedDay('2026-08-17')] },
  })
  eq('busy day: chips in spec order', b.chips.map(c => c.id).join(), 'visits,conflicts,followups,overdue,requests')
  const by = Object.fromEntries(b.chips.map(c => [c.id, c]))
  eq('visits label', by.visits.label, '7 visits today')
  eq('visits sub carries the booked value', by.visits.sub, `${formatCurrency(840)} booked`)
  eq('visits door = the schedule’s cursor-only day door', by.visits.href, `/dashboard/schedule?d=${TODAY}`)
  eq('conflicts label', by.conflicts.label, '1 schedule conflict')
  eq('ONE conflict deep-links THAT day', by.conflicts.href, '/dashboard/schedule?d=2026-08-17')
  eq('conflicts tone = urgent (the plan is fiction)', by.conflicts.tone, 'urgent')
  eq('followups label', by.followups.label, '2 quotes awaiting follow-up')
  eq('followups door = the quotes page (its Follow-ups tile is this same count)', by.followups.href, '/dashboard/quotes')
  eq('overdue label = THE ledger figure through formatCurrency', by.overdue.label, `${formatCurrency(1240)} overdue`)
  eq('overdue sub counts the invoices', by.overdue.sub, '3 invoices')
  eq('overdue door = the invoices page pre-filtered', by.overdue.href, '/dashboard/invoices?f=overdue')
  eq('requests label', by.requests.label, '1 customer request to review')
  check('every chip deep-links into the app', b.chips.every(c => c.href.startsWith('/dashboard')))
  check('no chip claims a zero (visits is the one always-on fact)',
    b.chips.every(c => c.id === 'visits' || (c.count ?? 0) > 0 || c.unavailable === true))
}

{
  const b = briefing({})
  eq('quiet day: exactly the visits chip, nothing else', b.chips.map(c => c.id).join(), 'visits')
  eq('…and it says so', b.chips[0].label, 'No visits today')
  check('…still a door (an empty day is an answer, and the schedule shows it)',
    b.chips[0].href === `/dashboard/schedule?d=${TODAY}`)
  check('…no booked-value sub at zero', b.chips[0].sub === undefined)
  check('the engine emits no celebration copy — that is TodaysPriorities’ job',
    !JSON.stringify(b).toLowerCase().includes('all clear') && !JSON.stringify(b).toLowerCase().includes('caught up'))
}

{
  const b = briefing({ stopsToday: 1, revenueToday: 0 })
  eq('singular visit', b.chips[0].label, '1 visit today')
}

{
  const b = briefing({ dayPlan: { ok: false, error: 'network' } as SourceResult<DayPlanRow> })
  const c = b.chips.find(x => x.id === 'conflicts')
  check('failed dayPlan source → an UNAVAILABLE chip, never a calm zero', !!c && c.unavailable === true)
  eq('…that says so in words', c?.label, 'Schedule check unavailable')
  eq('…with a null count (unknown, not zero)', c?.count ?? null, null)
  eq('…whose door is the inbox (where the failure banner names the source)', c?.href, '/dashboard/inbox')
}

{
  const b = briefing({ dayPlan: { ok: true, rows: [overbookedDay('2026-08-16'), overbookedDay('2026-08-18')] } })
  const c = b.chips.find(x => x.id === 'conflicts')
  eq('several conflicts pluralize', c?.label, '2 schedule conflicts')
  eq('…and open the inbox, where each day has its own row', c?.href, '/dashboard/inbox')
}

{
  // A warning-severity day is the schedule board's nuance, not a briefing alarm.
  // The literal warning object here tests THIS engine's severity filter only —
  // blocking verdicts above all come from the real planDay.
  const warnOnly: DayPlanRow = { date: TODAY, stops: 2, warnings: [{ severity: 'warning', message: 'tight day' } as DayPlanWarning] }
  const b = briefing({ dayPlan: { ok: true, rows: [warnOnly] } })
  check('non-blocking warnings do not mint a conflict chip', !b.chips.some(c => c.id === 'conflicts'))
}

// ── §3 Cross-engine door agreement ───────────────────────────────────────────
console.log('\n§3 doors — the chip and the queue open the same surface')

{
  const NO_LEADS: LeadResponseReport = { items: [], total: 0, bySource: { website: 0, reply: 0, booking: 0 }, oldestHours: null }
  const rows = computePriorities({
    quotes: [], invoices: [], jobs: [], recById: {},
    customers: [], conversations: [],
    requests: [{ customer_id: 'c1' }],
    leads: NO_LEADS, seasons: settingsToSeasons(null), feeSettings: null, today: TODAY,
  })
  const requestsRow = rows.find(r => r.kind === 'requests')
  const chip = briefing({ requestsOpen: 1 }).chips.find(c => c.id === 'requests')
  check('the requests chip and the S13 requests row share ONE door',
    !!requestsRow && !!chip && requestsRow.href === chip.href,
    `queue: ${requestsRow?.href} vs chip: ${chip?.href}`)
}

// ── §4 Static wiring — the page composes, the writes are safe ────────────────
console.log('\n§4 wiring — pinned in source')

const page = read('src/app/dashboard/page.tsx')
const dataSrc = read('src/lib/dashboard/data.ts')
const briefSrc = read('src/lib/dashboard/briefing.ts')
const layoutSrc = read('src/lib/dashboard/layout.ts')
const stripSrc = read('src/components/dashboard/OwnerBriefing.tsx')
const customizeSrc = read('src/components/dashboard/CustomizeDashboard.tsx')
const updatesSrc = read('src/components/inbox/InboxUpdates.tsx')
const invoicesSrc = read('src/app/dashboard/invoices/page.tsx')

check('page renders bands FROM the layout engine', page.includes('visibleDashboardCards(layout)'))
check('page composes the briefing from figures already in hand', page.includes('composeBriefing({'))
check('page renders the strip', page.includes('<OwnerBriefing chips={briefing.chips}'))
check('the layout read is tenant-scoped',
  /select\('dashboard_cards'\)\.eq\('user_id', user!\.id\)/.test(page))
check('a failed layout read resolves to the default, never the error screen',
  page.includes('layoutRes.error ? null'))
check('the layout read rides BESIDE the batch — data.ts stays free of preference reads',
  !dataSrc.includes('dashboard_cards'))
check('the page does not judge capacity itself (planDay stays behind the inbox source)',
  !/from '@\/lib\/dayPlan'/.test(page) && !/planDay\(/.test(page))
check('briefing engine is pure — no supabase import', !briefSrc.includes('supabase'))
check('briefing counts follow-ups via data.ts, which uses THE predicate',
  dataSrc.includes('quotes.filter(needsFollowUp).length'))
check('briefing requests count comes through openRequests (THE open predicate)',
  dataSrc.includes('requestsOpen: openReqs.length'))
check('layout engine documents the revived column and owns its access',
  layoutSrc.includes('dashboard_cards'))
check('strip chips are links with real touch targets', stripSrc.includes('tap-target-y'))
check('strip renders the unavailable glyph', stripSrc.includes('AlertTriangle'))
check('customize saves by UPSERT keyed on user_id (a bare update no-ops on a missing row)',
  customizeSrc.includes(".upsert({ user_id: uid, dashboard_cards: draft }, { onConflict: 'user_id' })"))
// Full-line comments stripped first: the component's own comment EXPLAINS the
// .update() trap, and matching it would fail the guard on its documentation —
// the grep-your-own-subject trap, again.
check('customize never uses .update on business_settings',
  !customizeSrc.replace(/^[ \t]*\/\/.*$/gm, '').includes('.update('))
check('customize holds no layout rules of its own — the engine’s helpers decide',
  customizeSrc.includes('toggleCardHidden(') && customizeSrc.includes('stepCard(') && !customizeSrc.includes('.splice('))
check('updates preview says when the source failed, instead of claiming a quiet week',
  updatesSrc.includes('unavailable') && updatesSrc.includes('updates may be missing'))
check('updates preview has one door when trimmed', updatesSrc.includes('View all updates'))
check('invoices page reads ?f= and validates it against the pills’ own vocabulary',
  invoicesSrc.includes("get('f')") && invoicesSrc.includes('valid.includes(f)'))
check('invoices pills actually include overdue (the chip’s destination filter)',
  invoicesSrc.includes("value: 'overdue'"))

// ── §5 The customize sheet's switches are thumb-sized, and only there ────────
// Toggle's outer <button> is the interactive target; with no label it is the
// 40×24 track (measured in the S97 a11y fixture). The sheet passes the shell's
// `tap-target` through Toggle's className — the primitive itself must stay
// inert for every other caller, and the track must keep its geometry.
console.log('\n§5 switches — a hit area for thumbs, geometry untouched')
{
  // Source pins (this guard runs under plain tsx, which has no JSX runtime for
  // rendering the component; the fixture branch measures the real thing).
  const toggle = read('src/components/ui/Toggle.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  // The outer <button>'s className is the one starting 'inline-flex …'; the
  // inner track/knob spans start 'relative …' / 'absolute …'.
  check('Toggle merges an optional className onto its OUTER button (the target), via cn',
    /className\?: string/.test(toggle) && /className=\{cn\('inline-flex[^']*rounded-full[^']*', className\)\}/.test(toggle))
  check('…and its base classes carry NO tap-target — existing callers are unchanged',
    !/tap-target/.test(toggle))
  check('…and the visible track is the 40×24 span (w-10 h-6) and cannot be squeezed by a long label (shrink-0)',
    /'relative w-10 h-6 shrink-0 rounded-full transition-colors duration-200'/.test(toggle))
  check('the customize sheet passes tap-target to its switches',
    /<Toggle[\s\S]{0,400}?className="tap-target"/.test(customizeSrc))
}

// ── Result ───────────────────────────────────────────────────────────────────
console.log('')
if (failures > 0) {
  console.log(`✗ verify:dashboard-v2 — ${failures} failure${failures !== 1 ? 's' : ''}`)
  process.exit(1)
}
console.log('✓ verify:dashboard-v2 — all checks passed')
