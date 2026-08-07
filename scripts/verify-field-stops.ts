// ── Field stop ordering verification — npm run verify:field-stops ────────────
//
// lib/fieldStops.ts is THE rule for "what order are today's stops driven in,
// and which one am I on next". Two surfaces render that answer: the day board's
// card list and the phone-only field bar whose one big button STARTS the job it
// names. They used to sort the same day independently, from different inputs,
// and the field bar's own comment claimed they "can never disagree".
//
// They disagreed on essentially every day in the book. The bar sorted by
// jobs.route_order — written only by a manual drag, null on 230 of 236
// production jobs and on every multi-stop day — while the board listed stops in
// the route position the optimizer resolved. With route_order and start_time
// both null the bar's sort was a no-op over equal keys, so "next stop" fell
// through to the fetch order (`scheduled_date, id` — UUID order). Start ran on
// the wrong customer; Complete drafted the wrong invoice.
//
// These are CHARACTERIZATION tests over the extracted engine. §4 is the
// regression itself: it reconstructs the old field-bar rule and asserts it
// picks a DIFFERENT stop than the board — so if anyone reintroduces a
// route_order-only sort on a field surface, this goes red instead of silently
// pointing a crew at the wrong driveway.

import {
  orderDayStops, nextFieldStop, UNPLACED_STOP_RANK, type FieldStop,
} from '../src/lib/fieldStops'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// A day's visit, in the shape the ordering rule reads.
const job = (
  id: string,
  status: FieldStop['status'] = 'scheduled',
  route_order: number | null = null,
  start_time: string | null = null,
): FieldStop => ({ id, status, route_order, start_time })

const ids = (stops: readonly FieldStop[]) => stops.map(s => s.id)

// The RESOLVED route position the board hands over: 1-based, as the route
// engine emits it (OrderedRouteStop.order).
const rank = (...idsInOrder: string[]) =>
  new Map(idsInOrder.map((id, i) => [id, i + 1]))

// ═══════════════════════════════════════════════════════════════════════════
H('1. ORDER — the resolved route position wins')

// The production shape: nobody has hand-ordered the day, so every route_order
// is null and the optimizer's geographic sequence is the only real order.
const unordered = [job('a'), job('b'), job('c'), job('d')]
check('resolved route order beats fetch order entirely',
  ids(orderDayStops(unordered, rank('c', 'a', 'd', 'b'))), ['c', 'a', 'd', 'b'])
check('a one-stop day is trivially itself',
  ids(orderDayStops([job('solo')], rank('solo'))), ['solo'])
check('no stops → no order', ids(orderDayStops([], rank())), [])

// A manual drag writes route_order; the board feeds those through sequenceRoute
// and hands the SAME positions back, so both inputs point the same way.
const manual = [job('a', 'scheduled', 3), job('b', 'scheduled', 1), job('c', 'scheduled', 2)]
check('manual sequence orders by its resolved positions',
  ids(orderDayStops(manual, rank('b', 'c', 'a'))), ['b', 'c', 'a'])

// ═══════════════════════════════════════════════════════════════════════════
H('2. FALLBACK — no resolved order yet (the route is still computing)')

// The optimizer resolves asynchronously. Until it does, the board has no
// positions either, so both surfaces must fall back the SAME way or they
// disagree mid-load — exactly when a crew is first opening the phone.
check('null rank falls back to route_order',
  ids(orderDayStops(manual, null)), ['b', 'c', 'a'])
check('null rank, no route_order → start_time breaks the tie',
  ids(orderDayStops([
    job('late', 'scheduled', null, '14:00'),
    job('early', 'scheduled', null, '08:30'),
    job('mid', 'scheduled', null, '11:00'),
  ], null)), ['early', 'mid', 'late'])
check('nothing to sort on at all → input order held (stable, not arbitrary)',
  ids(orderDayStops(unordered, null)), ['a', 'b', 'c', 'd'])

// A stop with no coordinates is not in the optimizer's output at all, so it has
// no resolved position. It must sink, not jump the queue.
check('an un-located stop sorts after every placed one',
  ids(orderDayStops([job('nowhere'), job('x'), job('y')], rank('y', 'x'))), ['y', 'x', 'nowhere'])
check('un-located stops keep a deterministic order among themselves',
  ids(orderDayStops([
    job('n2', 'scheduled', null, '13:00'),
    job('placed'),
    job('n1', 'scheduled', null, '09:00'),
  ], rank('placed'))), ['placed', 'n1', 'n2'])
check('UNPLACED_STOP_RANK is the documented sentinel', UNPLACED_STOP_RANK, 999)

// route_order still ranks an un-located stop when the optimizer skipped it.
check('route_order places a stop the optimizer could not',
  ids(orderDayStops([job('unlocated', 'scheduled', 2), job('p')], rank('p'))), ['p', 'unlocated'])

// Ordering must not mutate the caller's array — the board renders from props.
const frozen = [job('z'), job('y'), job('x')]
orderDayStops(frozen, rank('x', 'y', 'z'))
check('the input array is left untouched', ids(frozen), ['z', 'y', 'x'])

// ═══════════════════════════════════════════════════════════════════════════
H('3. NEXT STOP — what the field bar names and its button starts')

const day = orderDayStops(
  [job('first'), job('second'), job('third')],
  rank('first', 'second', 'third'),
)
check('next stop is the first one still to do', nextFieldStop(day)?.id, 'first')

// Completed work is behind you; the bar must move on.
check('a completed first stop is skipped',
  nextFieldStop(orderDayStops(
    [job('first', 'completed'), job('second'), job('third')],
    rank('first', 'second', 'third'),
  ))?.id, 'second')

// Cancelled work is not work. It must never be startable from the bar.
check('a cancelled stop is never next',
  nextFieldStop(orderDayStops(
    [job('killed', 'cancelled'), job('real')],
    rank('killed', 'real'),
  ))?.id, 'real')

// Whatever is on the clock wins regardless of position — you finish the job
// you are standing in, even if the route says it comes later.
check('an in-progress stop outranks an earlier scheduled one',
  nextFieldStop(orderDayStops(
    [job('first'), job('second', 'in_progress'), job('third')],
    rank('first', 'second', 'third'),
  ))?.id, 'second')
check('in-progress wins from the back of the route too',
  nextFieldStop(orderDayStops(
    [job('first'), job('second'), job('last', 'in_progress')],
    rank('first', 'second', 'last'),
  ))?.id, 'last')

// Undefined is what hides the bar — an empty or finished day must not point at
// anything, and must not throw.
check('a fully completed day has no next stop',
  nextFieldStop(orderDayStops([job('a', 'completed'), job('b', 'completed')], rank('a', 'b'))), undefined)
check('an empty day has no next stop', nextFieldStop(orderDayStops([], null)), undefined)
check('a day of only cancelled work has no next stop',
  nextFieldStop(orderDayStops([job('a', 'cancelled')], rank('a'))), undefined)

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE REGRESSION — board and field bar must name the SAME stop')

// The old field-bar rule, reconstructed verbatim from schedule/page.tsx before
// the fix. Kept here as the thing that must never come back.
function legacyFieldBarNext(stops: readonly FieldStop[]): FieldStop | undefined {
  const open = [...stops]
    .filter(s => s.status === 'in_progress' || s.status === 'scheduled')
    .sort((a, b) => {
      const oa = a.route_order ?? 999, ob = b.route_order ?? 999
      if (oa !== ob) return oa - ob
      return (a.start_time || '').localeCompare(b.start_time || '')
    })
  return open.find(s => s.status === 'in_progress') ?? open[0]
}

// A real production day: seven stops, no manual order, no appointment times —
// the shape every multi-stop day in the book has. Rows arrive in fetch order
// (`scheduled_date, id`), and the optimizer resolves a different sequence.
const productionDay = [job('aa11'), job('bb22'), job('cc33'), job('dd44'), job('ee55')]
const resolved = rank('dd44', 'aa11', 'ee55', 'bb22', 'cc33')
const boardOrder = orderDayStops(productionDay, resolved)

check('board lists the optimizer’s sequence', ids(boardOrder), ['dd44', 'aa11', 'ee55', 'bb22', 'cc33'])
check('field bar now names the board’s first stop', nextFieldStop(boardOrder)?.id, 'dd44')
// The bug, pinned: the old rule picked the first row of the FETCH, not of the route.
check('the old rule picked a different job (the bug this guards)',
  legacyFieldBarNext(productionDay)?.id, 'aa11')
check('…and that job is genuinely not the board’s first stop',
  legacyFieldBarNext(productionDay)?.id !== ids(boardOrder)[0], true)

// The agreement has to hold as the day is worked, not just at 7am.
const midDay = [job('aa11', 'completed'), job('bb22'), job('cc33'), job('dd44', 'completed'), job('ee55')]
const midBoard = orderDayStops(midDay, resolved)
check('mid-day, both agree on what is left', nextFieldStop(midBoard)?.id, 'ee55')

// And it has to hold before the route resolves, when the board has no positions
// either — the fallback path, not the resolved one.
check('pre-route, board and bar still agree',
  nextFieldStop(orderDayStops(productionDay, null))?.id, ids(orderDayStops(productionDay, null))[0])

// Sweep every prefix of a worked day: whatever is done so far, the bar's answer
// is always the board's first remaining card. This is the invariant, not a case.
{
  let agree = true
  for (let done = 0; done < productionDay.length; done++) {
    const worked = boardOrder.map((s, i) => (i < done ? { ...s, status: 'completed' as const } : s))
    const board = orderDayStops(worked, resolved)
    const firstOpen = board.find(s => s.status !== 'completed' && s.status !== 'cancelled')
    if (nextFieldStop(board)?.id !== firstOpen?.id) agree = false
  }
  check('every stage of the day: bar == board’s first remaining card', agree, true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} field stops: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
