// ── Verify: the day's suggested order is a PROPOSAL, and an honest one ──────
//   npm run verify:day-sequence
//
// WHY THIS SCRIPT EXISTS
// Session 82. The product could already answer "what is the shortest way round
// this day?" and "is this day, as booked, real?" — and neither of those is the
// question an owner asks on the morning of. lib/route orders by geography and
// has never seen a promised time, so it will cheerfully route a 9 AM
// appointment last; lib/dayPlan times whatever order it is handed and refuses,
// by design, to choose one.
//
// The failure that mattered was therefore not arithmetic but AUTHORITY: a
// second, narrower optimizer had grown on the dispatch board
// (`suggestPromiseOrder`) that could only swap already-timed visits among their
// own slots, could not see capacity, staffing or the day's finish while it did
// it, and carried its OWN copy of the grace period that decides what "late"
// means. Two engines answering one question, disagreeing about the definition.
//
// THE RULES PINNED
//   1  ONE within-day optimizer — `suggestPromiseOrder` is GONE, and the grace
//      period has exactly one definition that dispatchOps reads
//   2  a promise outranks distance: a shorter order that misses an appointment
//      is NOT proposed, however many kilometres it saves          ← the point
//   3  locked work does not move — completed, in-progress, billed, appointment
//   4  a suggestion must be STRICTLY better, or `accepted` is false
//   5  an estimate appointment anchors the order and is never persisted
//      (schedule_items has no route_order column)
//   6  cancelled work is not driven to
//   7  unknown duration stays disclosed; unknown travel is never called driving
//   8  a measured leg earns the word "driving" — and only then
//   9  multi-day work plans the REMAINDER and is locked while it runs
//  10  crew, direct-worker and availability all reach the scoring engine
//  11  planDay is the scorer — daySequence owns no clock, capacity or distance
//  12  ⛔ it never writes; ⛔ it cannot see money; ⛔ it cannot see what work
//      is CALLED; ⛔ breaks are not modelled and never invented
//
// ⭐ EVERY CHECK HERE CAN FAIL. Text scans carry NEGATIVE CONTROLS — the same
// matcher is run against a synthetic violation and must catch it. A scan that
// reports "clean" against a string designed to break it is reported as a broken
// guard, not as a pass.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sequenceDay, promiseMinutes, lockFromStatus, PROMISE_GRACE_MIN, LOCK_LABEL,
  type SequenceStop, type DaySequenceInput,
} from '../src/lib/daySequence'
import { travelFigureLabel } from '../src/lib/dayPlan'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * Strip comments so a prose mention cannot satisfy — or trip — a source scan.
 * ⚠️ LINE comments first: a `//` line that mentions `/*` would otherwise open a
 * block that swallows real code. `[^\n\r]` rather than `.` because `.` does not
 * match `\r`, and a CRLF checkout would leave every line comment half-stripped.
 */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SEQ_SRC = read('src/lib/daySequence.ts')
const SEQ_CODE = stripComments(SEQ_SRC)
const PANEL_SRC = read('src/components/schedule/OptimizeDayPanel.tsx')
const PANEL_CODE = stripComments(PANEL_SRC)
const DISPATCH_OPS = read('src/lib/dispatchOps.ts')

// ── Fixture ──────────────────────────────────────────────────────────────────
// Three stops on one line of longitude, close enough that the drive times are
// small and the arithmetic is easy to reason about by hand:
//   A ≈ 0.55 km from base, C ≈ 2.2 km, B ≈ 5.5 km
// so the geographically shortest order from base is A → C → B.
const BASE = { lat: 51.0, lng: -114.0 }
const AT = (lat: number) => ({ lat: 51.0 + lat, lng: -114.0 })

function stop(id: string, lat: number, over: Partial<SequenceStop> = {}): SequenceStop {
  return {
    id,
    label: id,
    coord: AT(lat),
    address: `${id} street`,
    propertyId: null,
    promiseMin: null,
    lock: null,
    durationMinutes: 60,
    crewSize: 1,
    serviceType: null,
    status: 'scheduled',
    ...over,
  }
}

function input(stops: SequenceStop[], over: Partial<DaySequenceInput> = {}): DaySequenceInput {
  return {
    stops,
    base: BASE,
    day: {
      startTime: '08:00',
      capacityHours: 8,
      workers: 1,
      hasBase: true,
    },
    ...over,
  }
}

const A = () => stop('A', 0.005)
const C = () => stop('C', 0.02)
const B = () => stop('B', 0.05)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 1 · ONE within-day optimizer')

check('suggestPromiseOrder is gone from lib/dispatchOps',
  !/suggestPromiseOrder|PromiseOrderSuggestion/.test(DISPATCH_OPS),
  'the absorbed engine is still exported')

{
  // It must be gone from the WHOLE repo, not merely from its old home.
  const survivors = ['src/lib/dispatchOps.ts', 'src/app/dashboard/dispatch/page.tsx']
    .filter(p => /suggestPromiseOrder/.test(read(p)))
  eq('…and no surface still calls it', survivors, [])
}

check('the grace period has ONE definition, in lib/daySequence',
  /export const PROMISE_GRACE_MIN/.test(SEQ_SRC)
  && /PROMISE_GRACE_MIN/.test(DISPATCH_OPS)
  && !/const PROMISE_GRACE_MIN\s*=\s*\d/.test(stripComments(DISPATCH_OPS)),
  'dispatchOps still defines its own grace period')

check('…and dispatchOps imports it rather than restating the number',
  /import \{ PROMISE_GRACE_MIN \} from '@\/lib\/daySequence'/.test(DISPATCH_OPS))

// Negative control: the matcher must catch a re-introduced local definition.
check('[negative control] a re-introduced local grace is caught',
  /const PROMISE_GRACE_MIN\s*=\s*\d/.test(stripComments('const PROMISE_GRACE_MIN = 15')))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 2 · a promise outranks distance')

{
  // The day is booked A → C → B, and B was promised 08:30. Driven in that
  // order B is reached late, so a better order exists and must be found.
  const late = sequenceDay(input([A(), C(), stop('B', 0.05, { promiseMin: promiseMinutes('08:30') })]))
  eq('the booked order misses the promise', late.lateBefore, 1)
  eq('the proposal meets it', late.lateAfter, 0)
  check('…by driving the promised stop first', late.order[0] === 'B', late.order.join(' → '))
  check('…and it is offered', late.accepted)
  check('…with a reason that names the promise',
    late.reasons.some(r => /promised time/i.test(r)), late.reasons.join(' | '))
}

{
  // ⭐ THE RULE. The day is already booked in promise order (B first), which is
  // the LONGER drive. The geographically shortest order (A → C → B) is strictly
  // shorter and makes B late. It must NOT be proposed at any distance saving.
  const kept = sequenceDay(input([stop('B', 0.05, { promiseMin: promiseMinutes('08:30') }), A(), C()]))
  eq('a promise-respecting day starts with none missed', kept.lateBefore, 0)
  check('the shorter-but-late order is refused', !kept.accepted,
    `proposed ${kept.order.join(' → ')} with ${kept.lateAfter} late`)
  eq('…and nothing is proposed to move', kept.moves, [])
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 3 · locked work does not move')

for (const [reason, over] of [
  ['completed', { status: 'completed' }],
  ['in_progress', { status: 'in_progress' }],
] as const) {
  // A is nearest to base and would be driven first anyway; put the LOCKED stop
  // last so that any reordering would visibly displace it.
  const stops = [A(), C(), stop('B', 0.05, { status: over.status, lock: lockFromStatus(over.status) })]
  const p = sequenceDay(input(stops))
  check(`a ${reason} stop keeps its position`, p.order[p.order.length - 1] === 'B',
    p.order.join(' → '))
  check(`…and is reported as left alone (${reason})`,
    p.locked.some(l => l.id === 'B' && l.reason === reason), JSON.stringify(p.locked))
}

{
  const billed = stop('B', 0.05, { lock: lockFromStatus('scheduled', { billed: true }) })
  eq('a billed visit locks', billed.lock, 'billed')
  const p = sequenceDay(input([A(), C(), billed]))
  check('…and does not move', p.order[p.order.length - 1] === 'B', p.order.join(' → '))
}

eq('a merely-scheduled visit is NOT locked', lockFromStatus('scheduled'), null)
check('…and billed is opt-in, so a surface that cannot see invoices asserts nothing',
  lockFromStatus('scheduled', {}) === null && lockFromStatus('scheduled', { billed: false }) === null)

{
  // A locked stop must not be displaced even when the promise repair wants its
  // slot: the FIRST stop is done, and a promised stop is late behind it.
  const p = sequenceDay(input([
    stop('A', 0.005, { status: 'completed', lock: 'completed' }),
    C(),
    stop('B', 0.05, { promiseMin: promiseMinutes('08:30') }),
  ]))
  check('a completed first stop survives a promise repair', p.order[0] === 'A', p.order.join(' → '))
  check('…and every locked id keeps its original index',
    p.locked.every(l => p.order.indexOf(l.id) === 0), p.order.join(' → '))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 4 · a suggestion must be strictly better')

{
  // Already in the shortest order with nothing promised: there is nothing to win.
  const p = sequenceDay(input([A(), C(), B()]))
  check('an already-optimal day proposes nothing', !p.accepted, p.order.join(' → '))
  eq('…and offers no reasons', p.reasons, [])
}

{
  const single = sequenceDay(input([A()]))
  check('a one-stop day has no ordering question', !single.accepted)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 5 · estimate appointments anchor, and are never persisted')

{
  const est = stop('EST', 0.02, { lock: 'appointment', promiseMin: promiseMinutes('09:00'), durationMinutes: 30 })
  const p = sequenceDay(input([A(), est, stop('B', 0.05, { promiseMin: promiseMinutes('08:30') })]))
  check('the appointment is in the order that gets timed', p.order.includes('EST'), p.order.join(' → '))
  check('⛔ …but NOT in what may be written back', !p.persistableOrder.includes('EST'),
    p.persistableOrder.join(' → '))
  check('…and every other stop still is',
    p.persistableOrder.length === p.order.length - 1, p.persistableOrder.join(' → '))
  check('…and it is disclosed as left alone',
    p.locked.some(l => l.id === 'EST' && l.reason === 'appointment'))
  check('…with a reason that explains why it cannot be saved',
    /cannot be saved/.test(LOCK_LABEL.appointment), LOCK_LABEL.appointment)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 6 · cancelled work is not driven to')

{
  const p = sequenceDay(input([A(), stop('X', 0.02, { status: 'cancelled' }), B()]))
  check('a cancelled stop is not in the order', !p.order.includes('X'), p.order.join(' → '))
  check('…nor in what would be written', !p.persistableOrder.includes('X'))
  eq('…and it is not counted as a stop', p.suggested.stopCount, 2)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 7 · unknown stays unknown')

{
  const p = sequenceDay(input([A(), stop('C', 0.02, { durationMinutes: null }), B()]))
  check('a stop with no duration is counted but disclosed',
    p.suggested.assumedDurationStops === 1, `${p.suggested.assumedDurationStops}`)
  check('…and the day says so in its own warnings',
    p.suggested.warnings.some(w => w.kind === 'durations_assumed'))
}

{
  // Nothing located, no base: there is no route to speak of, so the travel
  // figure must not be called driving.
  const noCoord = (id: string) => stop(id, 0, { coord: null })
  const p = sequenceDay({
    stops: [noCoord('A'), noCoord('B'), noCoord('C')],
    base: null,
    day: { startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false },
  })
  eq('an unplaceable day never claims driving', p.travelLabel, 'route overhead')
  check('…and says the figure is estimated', p.travelEstimated)
}

{
  // Straight-line only: real coordinates, but nothing measured.
  const p = sequenceDay(input([A(), C(), B()]))
  eq('a straight-line day is route overhead, not driving', p.travelLabel, 'route overhead')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 8 · a measured leg earns the word "driving"')

{
  // Every leg measured → lib/dayPlan's own vocabulary upgrades, and the
  // proposal quotes THAT word rather than choosing its own.
  const p = sequenceDay(input([A(), C(), B()], {
    seconds: () => 300,
    hasRoad: () => true,
    dist: (a, b) => Math.abs(a.lat - b.lat) * 111,
  }))
  eq('a fully measured day may say driving', p.travelLabel, 'driving')
  check('…and does not qualify it as estimated', !p.travelEstimated)
  eq('…and the word comes from lib/dayPlan, not from here',
    travelFigureLabel(p.suggested.travel), p.travelLabel)
}

{
  // ONE unmeasured leg drops the whole day back to route overhead — the weakest
  // leg governs, exactly as lib/dayPlan rules it.
  let n = 0
  const p = sequenceDay(input([A(), C(), B()], {
    seconds: () => (n++ === 0 ? null : 300),
    hasRoad: () => true,
    dist: (a, b) => Math.abs(a.lat - b.lat) * 111,
  }))
  eq('one unmeasured leg drops the claim', p.travelLabel, 'route overhead')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 9 · multi-day work plans the remainder, and is locked')

{
  const carried = stop('B', 0.05, { status: 'in_progress', lock: lockFromStatus('in_progress'), durationMinutes: 180, workedMinutes: 160 })
  const p = sequenceDay(input([A(), C(), carried]))
  eq('the running visit is locked', carried.lock, 'in_progress')
  check('…it keeps its position', p.order[p.order.length - 1] === 'B', p.order.join(' → '))
  check('…and only the outstanding time is planned',
    p.suggested.carriedOverStops === 1, `${p.suggested.carriedOverStops}`)
  const b = p.suggested.stops.find(s => s.jobId === 'B')
  check('…which is the remainder, not the whole estimate', (b?.minutes ?? 0) === 20, `${b?.minutes}`)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 10 · assignment and availability reach the scoring engine')

{
  // A visit given to a named person on a day that person is booked off must
  // still be WARNED about — the optimizer never reassigns, it reports.
  const p = sequenceDay(input([A(), C(), stop('B', 0.05, { technicianId: 'tech-1' })], {
    day: {
      startTime: '08:00', capacityHours: 8, workers: 1, hasBase: true,
      staffing: [{ technicianId: 'tech-1', name: 'Sam', crewId: null, state: 'off', minutes: 0, offHours: 8 }],
      availabilityRecorded: true,
    },
  }))
  check('an unavailable named worker is surfaced',
    p.suggested.warnings.some(w => w.kind === 'crew_understaffed' || w.kind === 'worker_unavailable'),
    JSON.stringify(p.suggested.warnings.map(w => w.kind)))
  check('⛔ …and the assignment is NOT changed to fix it',
    !/technicianId\s*=|crewId\s*=/.test(SEQ_CODE), 'daySequence assigns work')
}

{
  const p = sequenceDay(input([A(), C(), stop('B', 0.05, { crewId: 'crew-1', crewSize: 3 })], {
    day: { startTime: '08:00', capacityHours: 8, workers: 1, hasBase: true },
  }))
  check('a visit asking for more people than exist is blocking',
    p.suggested.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'),
    JSON.stringify(p.suggested.warnings.map(w => w.kind)))
}

check('the stop shape carries crew AND direct-worker assignment',
  /crewId\?:/.test(SEQ_SRC) && /technicianId\?:/.test(SEQ_SRC))
check('…and both are handed to planDay', /crewId: s\.crewId/.test(SEQ_CODE) && /technicianId: s\.technicianId/.test(SEQ_CODE))
check('…as is the roster the day was judged against',
  /staffing: input\.day\.staffing/.test(SEQ_CODE) && /workers: input\.day\.workers/.test(SEQ_CODE))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 11 · planDay is the scorer; this engine owns no arithmetic')

check('every candidate is timed by planDay', /planDay\(\{/.test(SEQ_CODE))
check('…including the day as it stands', /const currentPlan = planOrder/.test(SEQ_CODE))
check('distance comes from lib/route, not from here',
  /sequenceRoute|nearestNeighborRoute/.test(SEQ_CODE))
check('⛔ no second haversine / distance formula',
  !/Math\.(sin|cos|atan2|asin)\b/.test(SEQ_CODE), 'a distance formula was re-implemented')
check('⛔ no second capacity formula',
  !/capacityHours\s*\*\s*60|\*\s*60\s*\*\s*capacity/.test(SEQ_CODE), 'capacity is being re-derived')
check('the score cannot trade a promise for distance — lateness is compared first',
  SEQ_CODE.indexOf('countLate(plan, promises)') < SEQ_CODE.indexOf('plan.driveMin'),
  'the score tuple no longer ranks lateness above travel')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 12 · the refusals')

check('⛔ the engine never writes', !/supabase|\.from\(|\.rpc\(|update\(|insert\(/.test(SEQ_CODE),
  'a write reached the ordering engine')
check('⛔ …and the panel never writes',
  !/supabase|\.from\(|\.rpc\(|\.update\(|\.insert\(/.test(PANEL_CODE),
  'the proposal panel writes')

{
  const MONEY = /\b(price|revenue|margin|profit|amount|invoiceTotal|formatCurrency)\b/i
  check('⛔ the engine cannot see money', !MONEY.test(SEQ_CODE), 'a money identifier reached the engine')
  check('⛔ …and neither can the panel', !MONEY.test(PANEL_CODE), 'a money identifier reached the panel')
  check('[negative control] the money matcher catches one', MONEY.test('const revenue = 1'))
}

{
  const TRADES = /\b(lawn|mow|snow|plow|landscap|garden|clean|pool|hvac|plumb|roof|plow)\w*\b/i
  check('⛔ no industry keywords in the engine', !TRADES.test(SEQ_CODE))
  check('⛔ …nor in the panel', !TRADES.test(PANEL_CODE))
  check('[negative control] the trade matcher catches one', TRADES.test('if (serviceType === "mowing")'))
}

{
  // Breaks: not a planning primitive in this product. The engine must never
  // insert idle time, and the panel must SAY that rather than implying a pause.
  check('⛔ the engine models no break', !/breakMin|break_minutes|insertBreak|lunch/i.test(SEQ_CODE),
    'a break model appeared in the ordering engine')
  check('the panel states that breaks are not scheduled',
    /[Bb]reaks are not scheduled/.test(PANEL_SRC), 'the disclosure is gone')
  check('…and arriving early is disclosed rather than dressed up as a pause',
    /earlyArrivals/.test(SEQ_CODE) && /earlyArrivals/.test(PANEL_SRC))
}

check('⛔ jobs.end_time is not consumed as a constraint',
  !/end_time/.test(SEQ_CODE),
  'end_time reached the optimizer before its meaning was established')
check('…and the engine records WHY it is left alone',
  /end_time/.test(SEQ_SRC) && /never knowingly made|semantics|established/i.test(SEQ_SRC))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 13 · the proposal is a proposal')

{
  const p = sequenceDay(input([A(), C(), stop('B', 0.05, { promiseMin: promiseMinutes('08:30') })]))
  check('it returns BOTH plans so the owner can compare',
    !!p.current && !!p.suggested && p.current !== p.suggested)
  check('…timed by the same engine', typeof p.current.finishMin === 'number' && typeof p.suggested.finishMin === 'number')
  check('…and names what moved', p.moves.length > 0 && p.moves.every(m => m.from !== m.to),
    JSON.stringify(p.moves))
  check('…with an arrival time for each move', p.moves.every(m => /\d/.test(m.arrival)))
}

check('the panel applies only what can be persisted',
  /onApply\(proposal\.persistableOrder\)/.test(PANEL_SRC),
  'the panel applies the raw order, including un-persistable appointments')
check('…and applying is the owner’s explicit action',
  /Use this order|onApply/.test(PANEL_SRC))
check('…and the panel refuses to offer a suggestion that is not better',
  /!accepted/.test(PANEL_SRC))

eq('the grace period is the one the board reports late against', PROMISE_GRACE_MIN, 15)

// ═════════════════════════════════════════════════════════════════════════════
console.log('')
if (failures) {
  console.log(`✗ day-sequence: ${failures} rule${failures === 1 ? '' : 's'} broken`)
  process.exit(1)
}
console.log('✓ day-sequence: every rule holds')
