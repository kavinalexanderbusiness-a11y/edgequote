// ── Verify: a pinned stop stays where the owner put it ──────────────────────
//   npm run verify:pinned-route
//
// WHY THIS SCRIPT EXISTS
// Session 110. Session 82 gave the day one optimizer that weighs promises,
// locked work, people and travel — and it re-ordered everything it was allowed
// to. The owner's actual morning has a third input the engine could not hear:
// "Brenda asked to be first, and I am not negotiating that."
//
// The two workarounds available before this both damaged something real:
//   • drag the stop, and the next optimize run puts it back — so manual
//     ordering reads as broken and the owner stops trusting the screen;
//   • give the customer a committed start time nobody promised them — which
//     puts a lie into the record that this product then TEXTS to a person.
//
// A pin is the third answer, and the whole risk of adding it is that it gets
// confused with one of the four things it is not. That is most of what this
// guard pins.
//
// THE RULES PINNED
//   1  a pin is HELD: pinned positions survive optimize-remaining, mid-day and
//      in combination                                              ← the point
//   2  a pin is RELEASABLE, and releasing one really frees the stop
//   3  a pin is not a promise: lateness is still scored against the committed
//      time, and a pin can never manufacture, move or silence one
//   4  a pin is not route_order: applying a suggestion pins nothing
//   5  a pin is not persistable for an ESTIMATE — kind, not lock, decides what
//      may be written, so a pinned estimate never enters a route_order write
//   6  with no pins, Session 82's behaviour is byte-for-byte unchanged
//   7  a pin whose stop left the day is DROPPED, never re-aimed at a neighbour
//   8  a day that gains a stop keeps its valid pins
//   9  conflicts are SURFACED, never silently obeyed and never silently broken
//  10  crew, direct-worker and availability still reach the scorer
//  11  unknown travel and unknown duration stay unknown — no fake savings
//  12  ⛔ nothing here writes; the ONE route_order writer is still the one
//      Session 82 used; ⛔ no money; ⛔ no industry keywords; ⛔ no localStorage
//
// ⭐ EVERY CHECK HERE CAN FAIL. Text scans carry NEGATIVE CONTROLS, and the
// ordering checks use MID-DAY pins plus a permutation invariant — a pin at the
// END of a day is preserved by accident (nothing follows it to take its place),
// which is exactly how Session 82's lock test first passed against its own
// mutant.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sequenceDay, analysePinConflict, promiseMinutes, lockFromStatus, isReleasable,
  LOCK_LABEL, PROMISE_GRACE_MIN,
  type SequenceStop, type DaySequenceInput,
} from '../src/lib/daySequence'
import {
  orderWithPins, reconcilePins, repositionPins, pinAtCurrentPosition, unpin,
  pinnedIdSet, isPinned, pinSummary,
  type RoutePin,
} from '../src/lib/routePins'

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
 * ⚠️ LINE comments first, and `[^\n\r]` rather than `.`: `.` does not match
 * `\r`, so on a CRLF checkout every line comment would be left half-stripped
 * and the block-comment pass could then swallow real code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const PINS_SRC = read('src/lib/routePins.ts')
const PINS_CODE = stripComments(PINS_SRC)
const SEQ_SRC = read('src/lib/daySequence.ts')
const SEQ_CODE = stripComments(SEQ_SRC)
const BOARD_SRC = read('src/components/schedule/DayOpsPanel.tsx')
const BOARD_CODE = stripComments(BOARD_SRC)
const ROUTE_PANEL_SRC = read('src/components/schedule/DayRoutePanel.tsx')
const ROUTE_PANEL_CODE = stripComments(ROUTE_PANEL_SRC)
const OPT_PANEL_SRC = read('src/components/schedule/OptimizeDayPanel.tsx')

// ── Fixture ──────────────────────────────────────────────────────────────────
// Six stops on one line of longitude, increasing distance from base, so the
// geographically shortest order from base is simply A B C D E F. That makes
// "the optimizer wanted to move this" unambiguous: any day booked in another
// order has a strictly better geographic candidate available.
const BASE = { lat: 51.0, lng: -114.0 }
const AT = (d: number) => ({ lat: 51.0 + d, lng: -114.0 })

function stop(id: string, d: number, over: Partial<SequenceStop> = {}): SequenceStop {
  return {
    id,
    label: id,
    coord: AT(d),
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
      capacityHours: 10,
      workers: 1,
      hasBase: true,
    },
    ...over,
  }
}

const A = (o: Partial<SequenceStop> = {}) => stop('A', 0.005, o)
const B = (o: Partial<SequenceStop> = {}) => stop('B', 0.010, o)
const C = (o: Partial<SequenceStop> = {}) => stop('C', 0.015, o)
const D = (o: Partial<SequenceStop> = {}) => stop('D', 0.020, o)
const E = (o: Partial<SequenceStop> = {}) => stop('E', 0.025, o)
const F = (o: Partial<SequenceStop> = {}) => stop('F', 0.030, o)

/** A day booked in the WORST geographic order, so the optimizer always has
 *  somewhere better to go and "it did not move" means something. */
const reversed = () => [F(), E(), D(), C(), B(), A()]

/** Positions, 1-based, by id. */
const posOf = (order: string[]) => new Map(order.map((id, i) => [id, i + 1]))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 1 · with no pins, Session 82 is unchanged')

{
  const p = sequenceDay(input(reversed()))
  check('the reversed day is improved', p.accepted, 'nothing was proposed for an obviously bad order')
  eq('…to the geographic order', p.order, ['A', 'B', 'C', 'D', 'E', 'F'])
  check('…and every stop is persistable (all are visits)',
    p.persistableOrder.length === 6)
  check('…no stop reports a pin', p.locked.every(l => l.reason !== 'pinned'),
    JSON.stringify(p.locked))
}

{
  // The pinned code path must be IDENTICAL when nothing is pinned — not merely
  // similar. Same input, one with the field absent and one with it false.
  const withField = sequenceDay(input(reversed().map(s => ({ ...s, pinned: false }))))
  const without = sequenceDay(input(reversed()))
  eq('pinned:false is the same day as no pinned field at all',
    withField.order, without.order)
  eq('…including what it says moved', withField.moves.length, without.moves.length)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 2 · a pin is HELD')

{
  // Scenario 2: pin position #1 — the brief's headline case. F is the FARTHEST
  // stop, so pinning it first is the most expensive instruction the owner can
  // give, and the day behind it is booked in a deliberately poor order.
  const p = sequenceDay(input([F({ pinned: true }), C(), A(), D(), E(), B()]))
  eq('a stop pinned at #1 is still at #1', p.order[0], 'F')
  check('…and the rest WAS re-ordered around it', p.accepted, 'nothing was proposed at all')
  // ⭐ Driving order CONTINUED FROM F, not from base: the van is standing at
  // the pinned stop when it starts on the rest.
  eq('…into driving order continuing from it', p.order, ['F', 'E', 'D', 'C', 'B', 'A'])
  check('…which is genuinely shorter than the day as booked',
    p.travelSavedMin > 0, String(p.travelSavedMin))
  check('…and the pin is reported as a lock the owner owns',
    p.locked.some(l => l.id === 'F' && l.reason === 'pinned'), JSON.stringify(p.locked))
}

{
  // The same day WITHOUT the pin proves the pin actually constrained something
  // — otherwise the check above could pass on a day the engine never touched.
  const free = sequenceDay(input([F(), C(), A(), D(), E(), B()]))
  eq('unpinned, F is NOT first — the optimizer starts near base', free.order[0], 'A')
  check('…so the pinned run really was a different search',
    free.order.join() !== ['F', 'E', 'D', 'C', 'B', 'A'].join())
}

{
  // ⭐ THE MID-DAY PIN. A pin at the END of a day is held by accident — nothing
  // follows it to take the seat — so a broken implementation still passes.
  // Pinning C at #4 of 6 is the case that actually discriminates.
  const stops = [F(), E(), D(), C({ pinned: true }), B(), A()]
  const p = sequenceDay(input(stops))
  eq('a stop pinned mid-day keeps its exact index', p.order[3], 'C')
  check('…while everything else moved', p.order.filter((id, i) => id !== ['F', 'E', 'D', 'C', 'B', 'A'][i]).length > 0)
  // Permutation invariant: the result is the same six stops, once each.
  eq('…and the day is still the same six stops', [...p.order].sort(), ['A', 'B', 'C', 'D', 'E', 'F'])
}

{
  // Scenario 3: two pins — #1 and #4 — on a day booked badly enough that the
  // engine genuinely wants to move everything.
  const p = sequenceDay(input([F({ pinned: true }), C(), A(), D({ pinned: true }), E(), B()]))
  const pos = posOf(p.order)
  check('with two pins the day still improves', p.accepted, 'nothing was proposed')
  eq('…#1 holds', pos.get('F'), 1)
  eq('…and #4 holds', pos.get('D'), 4)
  eq('…and the unpinned stops fill exactly the free seats',
    [p.order[1], p.order[2], p.order[4], p.order[5]], ['E', 'C', 'B', 'A'])
  check('…both are reported as pinned',
    p.locked.filter(l => l.reason === 'pinned').map(l => l.id).sort().join() === 'D,F',
    JSON.stringify(p.locked))
  eq('…and the day is still the same six stops', [...p.order].sort(), ['A', 'B', 'C', 'D', 'E', 'F'])
}

{
  // Three pins, spread across the day. The engine must not "mostly" hold them.
  const p = sequenceDay(input([F({ pinned: true }), C(), D({ pinned: true }), E(), B({ pinned: true }), A()]))
  const pos = posOf(p.order)
  check('with three pins the day still improves', p.accepted, 'nothing was proposed')
  eq('three pins all hold', [pos.get('F'), pos.get('D'), pos.get('B')], [1, 3, 5])
  eq('…and the free stops take exactly the free seats',
    [p.order[1], p.order[3], p.order[5]], ['E', 'C', 'A'])
  eq('…and nothing was lost or duplicated', [...p.order].sort(), ['A', 'B', 'C', 'D', 'E', 'F'])
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 3 · a pin is RELEASABLE')

{
  // Scenario 4: unpin, and the stop must genuinely be free again.
  const pinned = sequenceDay(input([F(), E(), D(), C({ pinned: true }), B(), A()]))
  const released = sequenceDay(input([F(), E(), D(), C(), B(), A()]))
  eq('while pinned, C sits at #4', posOf(pinned.order).get('C'), 4)
  eq('once unpinned, the optimizer moves it', posOf(released.order).get('C'), 3)
  check('…which is a REAL difference, not the same order twice',
    pinned.order.join() !== released.order.join())
}

check('“pinned” is the only lock the owner may take back', isReleasable('pinned'))
check('…and a completed stop is not', !isReleasable('completed'))
check('…nor an in-progress one', !isReleasable('in_progress'))
check('…nor a billed one', !isReleasable('billed'))
check('…nor an estimate appointment', !isReleasable('appointment'))
check('the pin has an owner-facing label', /you/i.test(LOCK_LABEL.pinned), LOCK_LABEL.pinned)

{
  // A row's own lock OUTRANKS a pin: pinning a completed visit must not offer
  // an Unpin that cannot do anything.
  const p = sequenceDay(input([F(), E(), D(), C({ pinned: true, status: 'completed', lock: lockFromStatus('completed') }), B(), A()]))
  const note = p.locked.find(l => l.id === 'C')
  eq('a completed stop reports “completed”, not “pinned”', note?.reason, 'completed')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 4 · a pin is NOT a promise')

{
  // Scenario 7. P is promised 08:30 and sits near base. Pinning the FARTHEST
  // stop first makes that promise impossible — and the engine must say so
  // rather than either breaking the pin or hiding the lateness.
  const P = stop('P', 0.005, { promiseMin: promiseMinutes('08:30') })
  const stops = [F({ pinned: true }), P, C()]
  const report = analysePinConflict(input(stops))

  check('the conflict is detected', report.conflict,
    `late with pins ${report.lateWithPins}, without ${report.lateWithoutPins}`)
  check('…the pin was NOT silently overridden', report.withPins.order[0] === 'F',
    report.withPins.order.join())
  check('…the lateness is NOT hidden', report.withPins.latePromises.some(l => l.id === 'P'),
    JSON.stringify(report.withPins.latePromises))
  check('…and the responsible pin is named', report.culprits.some(c => c.id === 'F'),
    JSON.stringify(report.culprits))
  check('…with what releasing it would recover',
    report.culprits.every(c => c.recoversPromises > 0 || c.clearsBlocking > 0),
    JSON.stringify(report.culprits))
  check('…and the alternative is a real, better day',
    report.lateWithoutPins < report.lateWithPins,
    `${report.lateWithoutPins} vs ${report.lateWithPins}`)
}

{
  // ⛔ The conflict test is NARROW on purpose: extra DRIVING is the owner's to
  // spend and must never be reported as a conflict with choices attached.
  const stops = [F({ pinned: true }), E(), D(), C(), B(), A()]
  const report = analysePinConflict(input(stops))
  check('a pin that only costs kilometres is NOT a conflict', !report.conflict,
    `late ${report.lateWithPins}/${report.lateWithoutPins}, blocking ${report.blockingWithPins}/${report.blockingWithoutPins}`)
  check('…but the extra travel is disclosed as a number', report.extraTravelMin >= 0)
  check('…and the report knows there were pins to reason about', report.hadPins)
}

{
  const report = analysePinConflict(input(reversed()))
  check('with no pins there is nothing to report', !report.conflict && !report.hadPins)
  check('…and no culprits are invented', report.culprits.length === 0)
}

{
  // A pin cannot MANUFACTURE a promise: pinning an unpromised stop first must
  // not make it appear in latePromises or change anyone's committed time.
  const p = sequenceDay(input([F({ pinned: true }), E(), D(), C(), B(), A()]))
  check('a pinned stop with no promised time is never called late',
    !p.latePromises.some(l => l.id === 'F'), JSON.stringify(p.latePromises))
  eq('…and the day reports no missed promises at all', p.lateAfter, 0)
}

check('lateness is still measured against the committed time only',
  /promises\.get\(s\.jobId\)/.test(SEQ_CODE) && /arrivalMin > p \+ PROMISE_GRACE_MIN/.test(SEQ_CODE),
  'the lateness test no longer reads the promise map')
check('…and a pin is never written into the promise map',
  !/promises\.set\([^)]*pinned/.test(SEQ_CODE))
// Negative control: the matcher must catch a pin being treated as a promise.
check('[negative control] a pin-as-promise is caught',
  /promises\.set\([^)]*pinned/.test('promises.set(s.id, pinned)'))
eq('the grace period is still the one shared definition', PROMISE_GRACE_MIN, 15)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 5 · an estimate appointment: anchors, and is never persisted')

{
  // Scenario 5: a TIMED estimate between flexible visits.
  const est = stop('EST', 0.015, {
    kind: 'appointment', lock: 'appointment', promiseMin: promiseMinutes('10:00'), durationMinutes: 45,
  })
  const p = sequenceDay(input([F(), est, D(), C(), B(), A()]))
  eq('a timed estimate holds its index', p.order[1], 'EST')
  check('…the visits around it were re-ordered', p.accepted)
  check('…it is reported as an appointment', p.locked.some(l => l.id === 'EST' && l.reason === 'appointment'))
  check('…and it is EXCLUDED from what may be written',
    !p.persistableOrder.includes('EST'), p.persistableOrder.join())
  eq('…while every visit is included', p.persistableOrder.sort(), ['A', 'B', 'C', 'D', 'F'])
}

{
  // ⭐ THE BUG THIS SEPARATION EXISTS TO PREVENT. A PINNED estimate has lock
  // 'pinned', not 'appointment' — so a persistability test that read the LOCK
  // would emit a schedule_items id into a jobs.route_order write.
  const est = stop('EST', 0.015, { kind: 'appointment', pinned: true, durationMinutes: 45 })
  const p = sequenceDay(input([F(), est, D(), C(), B(), A()]))
  check('a PINNED estimate is still not persistable',
    !p.persistableOrder.includes('EST'), p.persistableOrder.join())
  check('…and it is reported as pinned, so the owner can release it',
    p.locked.some(l => l.id === 'EST' && l.reason === 'pinned'))
  eq('…and it held its seat', p.order[1], 'EST')
}

{
  // A Session 82 caller that never heard of `kind` must not regress into
  // persisting estimates.
  const est = stop('EST', 0.015, { lock: 'appointment', promiseMin: promiseMinutes('10:00') })
  const p = sequenceDay(input([F(), est, D(), C(), B(), A()]))
  check('a caller using only lock:“appointment” is still protected',
    !p.persistableOrder.includes('EST'), p.persistableOrder.join())
}

{
  // Scenario 6: a pinned VISIT and a timed estimate on one day — both respected.
  const est = stop('EST', 0.015, {
    kind: 'appointment', lock: 'appointment', promiseMin: promiseMinutes('10:00'), durationMinutes: 45,
  })
  const p = sequenceDay(input([F(), est, D(), C({ pinned: true }), B(), A()]))
  const pos = posOf(p.order)
  eq('the estimate keeps its slot', pos.get('EST'), 2)
  eq('…and the pinned visit keeps its own', pos.get('C'), 4)
  check('…and only the visit is persistable',
    p.persistableOrder.includes('C') && !p.persistableOrder.includes('EST'))
}

{
  // An UNTIMED located estimate participates in the route rather than being
  // dropped from planning (Session 82 excluded it, so the finish time silently
  // omitted a real drive) — but still cannot be persisted.
  const est = stop('EST', 0.015, { kind: 'appointment', durationMinutes: 45 })
  const withIt = sequenceDay(input([A(), B(), est]))
  const withoutIt = sequenceDay(input([A(), B()]))
  check('an untimed estimate is counted in the day',
    withIt.suggested.finishMin > withoutIt.suggested.finishMin,
    `${withIt.suggested.finishMin} vs ${withoutIt.suggested.finishMin}`)
  check('…is free to move (it has no promise to anchor it)',
    !withIt.locked.some(l => l.id === 'EST'))
  check('…and is still never persisted', !withIt.persistableOrder.includes('EST'))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 6 · the day changes underneath a pin')

{
  // Scenario 8: the pinned stop is cancelled.
  const pins: RoutePin[] = [{ stopId: 'C', kind: 'job', position: 4 }]
  const order = ['F', 'E', 'D', 'B', 'A']            // C is gone
  const r = reconcilePins(pins, order)
  eq('a pin whose stop left the day is dropped', r.pins.length, 0)
  eq('…and reported, so the surface can say why', r.dropped.map(p => p.stopId), ['C'])
  eq('…and it is NOT re-aimed at whoever now sits there',
    orderWithPins(order, r.pins), ['F', 'E', 'D', 'B', 'A'])
}

{
  // The engine's own behaviour with a cancelled pinned stop: cancelled work is
  // not driven to, so the pin cannot hold a seat in a day that has none.
  const p = sequenceDay(input([F(), E(), D(), C({ pinned: true, status: 'cancelled' }), B(), A()]))
  check('a cancelled pinned stop is not in the order', !p.order.includes('C'), p.order.join())
  check('…and does not appear as a lock', !p.locked.some(l => l.id === 'C'))
  eq('…and the rest of the day still optimizes', p.order, ['A', 'B', 'D', 'E', 'F'])
}

{
  // Scenario 9: a stop is ADDED to a day that already has pins.
  const pins: RoutePin[] = [
    { stopId: 'F', kind: 'job', position: 1 },
    { stopId: 'C', kind: 'job', position: 4 },
  ]
  const grown = ['F', 'E', 'D', 'C', 'B', 'A', 'G']
  const r = reconcilePins(pins, grown)
  eq('valid pins survive a day gaining a stop', r.pins.map(p => p.stopId), ['F', 'C'])
  eq('…and nothing was dropped', r.dropped.length, 0)
  const applied = orderWithPins(grown, r.pins)
  eq('…both pinned seats still hold', [applied[0], applied[3]], ['F', 'C'])
  eq('…and the new stop is in the day', applied.includes('G'), true)
  eq('…exactly once, with nothing lost', [...applied].sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
}

{
  // A day that SHRANK below a pin's position clamps rather than dropping it:
  // "keep this last" survives losing two stops.
  const pins: RoutePin[] = [{ stopId: 'A', kind: 'job', position: 6 }]
  const shrunk = ['C', 'B', 'A']
  const r = reconcilePins(pins, shrunk)
  eq('an out-of-range pin is clamped, not dropped', r.pins[0]?.position, 3)
  eq('…and reported as clamped', r.clamped.map(p => p.stopId), ['A'])
  eq('…and still lands last', orderWithPins(shrunk, r.pins)[2], 'A')
}

{
  // Two pins wanting one seat must still produce a valid day.
  const pins: RoutePin[] = [
    { stopId: 'A', kind: 'job', position: 2 },
    { stopId: 'B', kind: 'job', position: 2 },
  ]
  const out = orderWithPins(['A', 'B', 'C'], pins)
  eq('colliding pins still yield every stop once', [...out].sort(), ['A', 'B', 'C'])
  eq('…and the earlier pin keeps the seat it asked for', out[1], 'A')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 7 · lib/routePins — it records, it never invents')

{
  const order = ['F', 'E', 'D', 'C', 'B', 'A']
  const pins = pinAtCurrentPosition([], order, 'C', 'job')
  eq('a pin records the seat the stop is ALREADY in', pins[0].position, 4)
  eq('…and its kind', pins[0].kind, 'job')
  check('…and pinning is idempotent',
    pinAtCurrentPosition(pins, order, 'C', 'job').length === 1)
  eq('…pinning a stop that is not on the day does nothing',
    pinAtCurrentPosition([], order, 'ZZ', 'job'), [])
}

{
  const order = ['F', 'E', 'D', 'C', 'B', 'A']
  const pins = pinAtCurrentPosition(pinAtCurrentPosition([], order, 'F', 'job'), order, 'C', 'job')
  eq('unpin removes exactly one', unpin(pins, 'F').map(p => p.stopId), ['C'])
  check('isPinned agrees with the set', isPinned(pins, 'C') && !isPinned(pins, 'B'))
  eq('pinnedIdSet is the ids', [...pinnedIdSet(pins)].sort(), ['C', 'F'])
  check('the summary counts them', /2 pinned stops/.test(pinSummary(pins)), pinSummary(pins))
  check('…and reads naturally for one', /1 pinned stop$/.test(pinSummary([pins[0]])), pinSummary([pins[0]]))
  check('…and says so when there are none', /No pinned/.test(pinSummary([])))
}

{
  // ⭐ After a drag, every pin re-reads its seat. Without this the untouched
  // pins keep their OLD numbers and orderWithPins drags them back.
  const before = ['F', 'E', 'D', 'C', 'B', 'A']
  const pins = pinAtCurrentPosition([], before, 'C', 'job')      // C at #4
  const after = ['C', 'F', 'E', 'D', 'B', 'A']                   // owner moved C to #1
  const moved = repositionPins(pins, after)
  eq('a repositioned pin follows its stop', moved[0].position, 1)
  eq('…and the order is then stable under re-application',
    orderWithPins(after, moved), after)
}

{
  // Honesty rule 2 — a permutation, always.
  const order = ['A', 'B', 'C', 'D', 'E']
  const pins: RoutePin[] = [{ stopId: 'E', kind: 'job', position: 1 }, { stopId: 'A', kind: 'job', position: 5 }]
  const out = orderWithPins(order, pins)
  eq('orderWithPins returns the same stops', [...out].sort(), [...order].sort())
  eq('…the same number of them', out.length, order.length)
  eq('…with both pins honoured', [out[0], out[4]], ['E', 'A'])
}

eq('an empty day is handled', orderWithPins([], [{ stopId: 'A', kind: 'job', position: 1 }]), [])
eq('a day with no pins is untouched', orderWithPins(['A', 'B'], []), ['A', 'B'])

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 8 · assignment and availability still reach the scorer')

{
  // Scenarios 10 + 11: crew and direct-worker assignment survive pinning.
  const p = sequenceDay(input([
    F({ pinned: true, crewId: 'crew-1' }),
    E({ technicianId: 'tech-1' }),
    D({ crewId: 'crew-1' }),
    C(), B(), A(),
  ]))
  eq('a pinned crew-assigned stop keeps its seat', p.order[0], 'F')
  check('…and the day still plans', p.suggested.stopCount === 6, String(p.suggested.stopCount))
}

check('crew and technician are handed to the scorer, not read here',
  /crewId: s\.crewId/.test(SEQ_CODE) && /technicianId: s\.technicianId/.test(SEQ_CODE),
  'the assignment fields no longer flow into planDay')

{
  // Scenario 12: availability. A day nobody can staff must still say so with a
  // pin on it — a pin must never suppress a blocking verdict.
  const staffed = sequenceDay(input([F({ pinned: true, crewSize: 3 }), E(), D()], {
    day: { startTime: '08:00', capacityHours: 10, workers: 1, hasBase: true, availabilityRecorded: true, staffing: [] },
  }))
  check('a pinned day still reports its blocking problems',
    staffed.suggested.warnings.some(w => w.severity === 'blocking'),
    JSON.stringify(staffed.suggested.warnings.map(w => w.severity)))
}

check('availability reaches planDay through the day context',
  /availabilityRecorded: input\.day\.availabilityRecorded/.test(SEQ_CODE)
  && /staffing: input\.day\.staffing/.test(SEQ_CODE))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 9 · unknown stays unknown')

{
  // Scenario 13: with no measured road data, a saving is never called driving.
  const p = sequenceDay(input(reversed()))
  check('unmeasured travel is not called “driving”', p.travelLabel !== 'driving', p.travelLabel)
  check('…and is flagged as estimated', p.travelEstimated)
  check('…and every reason sentence that quotes it says so',
    p.reasons.filter(r => /less route overhead|less driving/.test(r)).every(r => /estimated/.test(r)),
    JSON.stringify(p.reasons))
}

{
  // …and no saving is claimed where there is nothing to compare.
  const p = sequenceDay(input([A({ pinned: true })]))
  eq('a one-stop day proposes nothing', p.accepted, false)
  eq('…and claims no reasons', p.reasons, [])
  eq('…and no travel saving', p.travelSavedMin, 0)
}

{
  // Scenario 14: unknown duration must be disclosed, not filled in silently.
  const p = sequenceDay(input([
    F({ pinned: true, durationMinutes: null }),
    E({ durationMinutes: null }),
    D({ durationMinutes: null }),
  ]))
  check('a day of unknown durations carries a caveat',
    p.suggested.warnings.some(w => w.severity === 'caveat'),
    JSON.stringify(p.suggested.warnings))
  eq('…and the pin still held', p.order[0], 'F')
}

check('the engine owns no clock, distance or capacity arithmetic',
  !/new Date\(|Date\.now\(|Math\.sqrt|6371/.test(SEQ_CODE),
  'lib/daySequence grew its own measurement')
// Negative control.
check('[negative control] a re-introduced distance formula is caught',
  /Math\.sqrt|6371/.test('const km = 6371 * c'))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 10 · ⛔ nothing here writes, and there is still ONE writer')

check('lib/routePins is pure — no React',
  !/from 'react'|useState|useEffect/.test(PINS_CODE))
check('…no Supabase', !/supabase|createClient/i.test(PINS_CODE))
check('…and no storage of its own',
  !/localStorage|sessionStorage|indexedDB|document\./i.test(PINS_CODE))
// Negative control.
check('[negative control] a storage call would be caught',
  /localStorage/i.test('localStorage.setItem("pins", x)'))

check('⛔ pins are NOT hidden in browser storage anywhere on these surfaces',
  !/localStorage|sessionStorage/i.test(BOARD_CODE + ROUTE_PANEL_CODE + stripComments(OPT_PANEL_SRC)),
  'a planning constraint that exists on one browser is a constraint that lies')

check('lib/daySequence still writes nothing',
  !/supabase|\.update\(|\.insert\(|fetch\(/.test(SEQ_CODE))
check('lib/routePins writes nothing',
  !/\.update\(|\.insert\(|fetch\(/.test(PINS_CODE))
check('the route panel writes nothing',
  !/supabase|\.update\(|\.insert\(/.test(ROUTE_PANEL_CODE),
  'the sequence panel reaches the database directly')

{
  // Scenario 15: the ONE route_order writer. There must be exactly one place
  // that sets route_order to a sequence, and both reorder paths must go
  // through it.
  const seqWrites = BOARD_CODE.match(/\.update\(\{ route_order: i \+ 1 \}\)/g) ?? []
  eq('exactly one route_order SEQUENCE write on the day board', seqWrites.length, 1)
  // The reset-to-optimizer path CLEARS route_order rather than sequencing it.
  // A different write, deliberately counted separately so that neither can
  // quietly become two.
  const clears = BOARD_CODE.match(/\.update\(\{ route_order: null \}\)/g) ?? []
  eq('…and exactly one reset-to-optimizer write', clears.length, 1)
  check('…and it is the Session 82 writer, unchanged',
    /seq\.map\(\(id, i\) => supabase\.from\('jobs'\)\.update\(\{ route_order: i \+ 1 \}\)/.test(BOARD_CODE),
    'the canonical applyOrder write has changed shape')
  check('…reached by the drag/move path', /commitSequence\(seq/.test(BOARD_CODE))
  check('…which persists only visits, never estimates',
    /seq\.filter\(id => jobIdSetRef\.current\.has\(id\)\)/.test(BOARD_CODE),
    'the unified sequence is written wholesale, including schedule_items ids')
  check('…and the panel applies only what may be persisted',
    /onApply\(proposal\.persistableOrder\)/.test(OPT_PANEL_SRC))
}

{
  // Scenario 16: declining writes nothing. The proposal is only computed while
  // the panel is open, and closing it goes nowhere near a write.
  check('the proposal is computed only while the panel is open',
    /if \(!optimizeOpen\) return null/.test(BOARD_CODE))
  check('…and closing simply closes', /onClose=\{\(\) => setOptimizeOpen\(false\)\}/.test(BOARD_SRC))
  check('…releasing a pin changes state only, never the database',
    /onReleasePins=\{ids => setPins\(/.test(BOARD_SRC))
}

check('⛔ pinning never happens on its own — only where the owner placed a stop',
  (BOARD_CODE.match(/pinAtCurrentPosition\(/g) ?? []).length === 2,
  'a third pinning site appeared; every pin must come from an owner action')

check('applying a suggestion repositions pins but creates none',
  /setPins\(prev => repositionPins\(prev, proposal\.order\)\)/.test(BOARD_CODE),
  'applying a suggested order pins what it moved')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 11 · the owner is told the truth about durability and conflict')

check('the route panel states that pins do not outlive the day',
  /Pins last while this day is open/.test(ROUTE_PANEL_SRC),
  'the durability limit is not disclosed')
check('…and the board passes that fact rather than claiming otherwise',
  /pinsPersist=\{false\}/.test(BOARD_SRC))

check('a conflict is named as a conflict',
  /Your pinned order causes a scheduling conflict/.test(OPT_PANEL_SRC))
check('…and offers keeping the owner’s order', /Keep my order/.test(OPT_PANEL_SRC))
check('…unpinning the stop responsible', /Unpin \{/.test(OPT_PANEL_SRC))
check('…and taking the suggestion instead', /Use suggested order/.test(OPT_PANEL_SRC))
check('…and says plainly when the pins WERE all kept',
  /pinned stop\{pinCount === 1 \? '' : 's'\} kept/.test(OPT_PANEL_SRC))
check('…and when a run deliberately ignored them',
  /This run ignores your/.test(OPT_PANEL_SRC))

check('the offer to re-optimize is an OFFER, never automatic',
  /Route changed — re-order the stops that are not pinned\?/.test(ROUTE_PANEL_SRC))
check('…with a way to decline', /Not now/.test(ROUTE_PANEL_SRC))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 12 · ⛔ no money, ⛔ no industry keywords, ⛔ no tenant reach')

// ⚠️ `\$\d` rather than a bare `\$`: a template literal's `${…}` is not money,
// and matching it made this check unfailable-by-accident in the wrong direction.
check('lib/routePins cannot see money',
  !/price|revenue|amount|invoice|currency|\$\d/i.test(PINS_CODE))
check('the route panel cannot see money',
  !/price|revenue|invoice|formatCurrency/i.test(ROUTE_PANEL_CODE))
// Negative control.
check('[negative control] a money reference would be caught',
  /price|revenue/i.test('const price = 10'))

{
  // ⛔ Nothing may inspect what the work is CALLED. `serviceType` is a token
  // passed through to the learned-duration lookup and never read here.
  const INDUSTRY = /\b(lawn|mow|snow|plow|pest|clean|pool|garden|hedge|tree|gutter|roof|paint|window)\b/i
  check('lib/routePins names no trade', !INDUSTRY.test(PINS_CODE))
  check('the route panel names no trade', !INDUSTRY.test(ROUTE_PANEL_CODE))
  check('[negative control] the trade matcher works', INDUSTRY.test('const hedge = 1'))
}

{
  // Scenario 18: a foreign tenant cannot touch another business's planning.
  // Pins are client state with no transport, so the ONLY thing that leaves the
  // browser is the route_order write — which goes through the RLS-scoped
  // browser client, exactly as it did before this session.
  check('the day board uses the RLS-scoped browser client',
    /from '@\/lib\/supabase\/client'/.test(BOARD_SRC))
  check('…and never a service-role key',
    !/SERVICE_ROLE|service_role|createServiceClient/i.test(BOARD_CODE + ROUTE_PANEL_CODE + PINS_CODE),
    'a planning surface reached for an RLS bypass')
  check('…and the write is still scoped to one row at a time by id',
    /\.update\(\{ route_order: i \+ 1 \}\)\.eq\('id', id\)/.test(BOARD_CODE))
  check('[negative control] a service-role reach would be caught',
    /SERVICE_ROLE/i.test('const k = process.env.SUPABASE_SERVICE_ROLE_KEY'))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('')
if (failures) {
  console.log(`✗ pinned-route: ${failures} rule${failures === 1 ? '' : 's'} broken`)
  process.exit(1)
}
console.log('✓ pinned-route: every rule holds')
