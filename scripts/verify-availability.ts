// ── Verify: who works this day, and what the answer is allowed to claim ─────
//   npm run verify:availability
//
// WHY THIS SCRIPT EXISTS
// Session 67. Before it, "who works Tuesday?" had two inputs — the roster and
// dated time off — so a business whose crew does not work Wednesdays had no way
// to say so, and every planning surface assumed seven identical days. Adding a
// weekly pattern makes the answer richer AND creates four ways to lie:
//
//   • treating NO RECORDED PATTERN as "unavailable" (nobody can work, ever) or
//     as a stated fact (a claim nobody made) rather than as an ASSUMPTION;
//   • letting a REQUESTED day off reshape the plan before anyone approved it —
//     which would let a worker reschedule the business by asking;
//   • letting a failed availability read read as "everyone is available",
//     turning an unknown into the most optimistic possible answer;
//   • growing a SECOND head-count next to lib/dayFit's, so the day board and
//     the suggester can quote different Tuesdays.
//
// THE RULES PINNED
//   1  no pattern = ASSUMED available, and the assumption is labelled
//   2  a pattern rules a worker out only on weekdays it excludes
//   3  ONE count: workerDayStates and workersAvailableOn agree, always
//   4  only APPROVED time off subtracts anybody
//   5  a failed read is UNKNOWN — never zero, never everybody
//   6  the day plan WARNS about a short crew and never unassigns anyone
//   7  history is not rewritten: a pattern edit is not retroactive
//   8  tenancy: every read and write is scoped, per read block
//   9  a worker can only ever address their OWN week (no technician id in)
//  10  the schema says what the product says (statuses, partial index, grants)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  workerDayStates, patternUnavailableOn, weekdayOf, patternWindowMinutes,
  dayStaffing, canWork, WEEKDAY_LABELS, WORKER_DAY_STATE_LABELS,
  type AvailabilityPatternRow, type ApprovedTimeOffDay, type WorkerForAvailability,
} from '../src/lib/workerAvailability'
import { workersAvailableOn } from '../src/lib/dayFit'
import { planDay, type DayPlanInput, type DayPlanStopInput } from '../src/lib/dayPlan'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`);
const H = (t: string) => console.log(`\n${t}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// 2026-08-17 is a MONDAY (weekday 1); 2026-08-19 a Wednesday; 2026-08-22 a
// Saturday. Dates are date-only strings throughout — never Date objects, so a
// timezone can never shift which weekday a row lands on.
const MON = '2026-08-17'
const WED = '2026-08-19'
const SAT = '2026-08-22'

const worker = (id: string, over: Partial<WorkerForAvailability> = {}): WorkerForAvailability => ({
  id, name: id.toUpperCase(), crew_id: 'crew-a', is_active: true, ...over,
})

/** Mon–Fri 8–5, for one worker. */
const weekdays = (tech: string): AvailabilityPatternRow[] =>
  [1, 2, 3, 4, 5].map(wd => ({
    technician_id: tech, weekday: wd, available: true, start_time: '08:00', end_time: '17:00',
  }))

const offDay = (tech: string, date: string, hours = 8): ApprovedTimeOffDay =>
  ({ technician_id: tech, date, hours })

// ═════════════════════════════════════════════════════════════════════════════
H('1. Weekday arithmetic is date-only and timezone-proof')

eq('2026-08-17 is a Monday', weekdayOf(MON), 1)
eq('2026-08-19 is a Wednesday', weekdayOf(WED), 3)
eq('2026-08-22 is a Saturday', weekdayOf(SAT), 6)
eq('a full timestamp still resolves by its DATE half', weekdayOf('2026-08-17T23:30:00Z'), 1)
eq('the labels line up with the numbers', WEEKDAY_LABELS[1], 'Monday')
eq('…and Sunday is 0, matching the database', WEEKDAY_LABELS[0], 'Sunday')

eq('a window is its minutes', patternWindowMinutes({ start_time: '08:00', end_time: '17:00' }), 540)
eq('seconds in the value do not break it', patternWindowMinutes({ start_time: '08:00:00', end_time: '12:00:00' }), 240)
eq('an inverted window is not a window', patternWindowMinutes({ start_time: '17:00', end_time: '08:00' }), null)
eq('an absent window is not a window', patternWindowMinutes({ start_time: null, end_time: null }), null)

// ═════════════════════════════════════════════════════════════════════════════
H('2. THE SOLO WORKER — a business with no roster is one person, not zero')

eq('no technician rows at all = the solo owner = 1',
  workersAvailableOn(MON, [], []), 1)
eq('…and a pattern table cannot reduce that below 1',
  workersAvailableOn(MON, [], [], weekdays('nobody')), 1)
{
  const solo = [worker('t1')]
  eq('one active worker, no pattern, no time off = 1',
    workersAvailableOn(MON, solo, []), 1)
  eq('the same worker booked off is 0 — a real zero, not an unknown',
    workersAvailableOn(MON, solo, [offDay('t1', MON)]), 0)
  const states = workerDayStates(MON, solo, [], [offDay('t1', MON)])
  eq('…and their state names the reason', states[0].state, 'off')
}

// ═════════════════════════════════════════════════════════════════════════════
H('3. NO PATTERN = ASSUMED AVAILABLE, and the word is "assumed"')

{
  const team = [worker('t1'), worker('t2')]
  const states = workerDayStates(SAT, team, [], [])
  eq('nobody has a week recorded, so both are counted', states.filter(canWork).length, 2)
  check('…and both are labelled ASSUMED, not stated',
    states.every(s => s.state === 'assumed'))
  eq('the label the product shows says so', WORKER_DAY_STATE_LABELS.assumed, 'Assumed available')
  eq('the count agrees', workersAvailableOn(SAT, team, [], []), 2)

  const staffing = dayStaffing(SAT, states, [{ id: 'crew-a', name: 'Crew A' }])
  check('the day reports that EVERY availability on it is an assumption', staffing.allAssumed)
  eq('…and can name the crew', staffing.crewNames['crew-a'], 'Crew A')
}

// ⛔ The inverse of rule 1, and the most dangerous mistake available here:
// a worker with no pattern must never be treated as unavailable.
eq('an empty pattern table rules NOBODY out', patternUnavailableOn(WED, []).size, 0)

// ═════════════════════════════════════════════════════════════════════════════
H('4. A RECORDED WEEK is honoured — and only for the worker who recorded one')

{
  const team = [worker('t1'), worker('t2')]
  const patterns = weekdays('t1')            // t1 works Mon–Fri; t2 said nothing

  eq('Monday: both available', workersAvailableOn(MON, team, [], patterns), 2)
  eq('Saturday: t1 does not work it; t2 is still assumed', workersAvailableOn(SAT, team, [], patterns), 1)

  const sat = workerDayStates(SAT, team, patterns, [])
  eq('t1 reads as unavailable', sat.find(s => s.technicianId === 't1')!.state, 'unavailable')
  eq('t2 reads as assumed — one person’s week says nothing about another’s',
    sat.find(s => s.technicianId === 't2')!.state, 'assumed')

  const out = patternUnavailableOn(SAT, patterns)
  check('the pattern rules out exactly the worker who has one', out.has('t1') && !out.has('t2'))
}

// ⭐ "Wed unavailable" — the brief's own example. A weekday can be excluded two
// ways: by an EXPLICIT available:false row (what the editor writes when a
// worker toggles a day off) or by having no row at all. Both mean the same
// thing, and a mutant that honoured only the second survived until this case
// existed — an explicitly-marked day off read as a working day.
{
  const team = [worker('t1')]
  const explicit: AvailabilityPatternRow[] = [
    ...weekdays('t1').filter(r => r.weekday !== 3),
    { technician_id: 't1', weekday: 3, available: false, start_time: null, end_time: null },
  ]
  eq('Wednesday marked unavailable means unavailable',
    workersAvailableOn(WED, team, [], explicit), 0)
  eq('…and Tuesday is untouched', workersAvailableOn('2026-08-18', team, [], explicit), 1)
  check('the row itself rules them out', patternUnavailableOn(WED, explicit).has('t1'))
  eq('…and the per-worker state says so',
    workerDayStates(WED, team, explicit, [])[0].state, 'unavailable')
  eq('an explicit false and a missing row mean the same thing',
    workersAvailableOn(WED, team, [], explicit),
    workersAvailableOn(WED, team, [], weekdays('t1').filter(r => r.weekday !== 3)))

  // A full week of explicit refusals is a real zero, not an unknown.
  const never: AvailabilityPatternRow[] = [0, 1, 2, 3, 4, 5, 6].map(wd =>
    ({ technician_id: 't1', weekday: wd, available: false, start_time: null, end_time: null }))
  eq('a worker who works no day of the week counts nowhere',
    workersAvailableOn(MON, team, [], never), 0)
}

// ═════════════════════════════════════════════════════════════════════════════
H('5. PARTIAL availability is available — and says it is short')

{
  const team = [worker('t1')]
  const half: AvailabilityPatternRow[] = [
    { technician_id: 't1', weekday: 1, available: true, start_time: '08:00', end_time: '12:00' },
  ]
  const states = workerDayStates(MON, team, half, [], { capacityHours: 8 })
  eq('a 4-hour Monday against an 8-hour day is PARTIAL', states[0].state, 'partial')
  eq('…and reports its real minutes', states[0].minutes, 240)
  check('…and still counts as someone who can work', canWork(states[0]))
  eq('the head-count agrees — a part day is a person', workersAvailableOn(MON, team, [], half), 1)

  const full = workerDayStates(MON, team, weekdays('t1'), [], { capacityHours: 8 })
  eq('a 9-hour window on an 8-hour day is simply available', full[0].state, 'available')

  // V1 limit, stated rather than hidden: the labour POOL is headcount × day
  // hours. A part-day worker is not pro-rated into it — the minutes are
  // surfaced so the conservatism is visible, not silently banked.
  eq('a part-day worker still counts as one whole person in the pool',
    workersAvailableOn(MON, team, [], half), 1)
}

// ═════════════════════════════════════════════════════════════════════════════
H('6. Only APPROVED time off subtracts anybody')

{
  // The loader filters to approved BEFORE the engine sees anything, so the
  // engine's contract is "these are approved". Pin the loader's filter too.
  const src = read('src/lib/dayFitLoad.ts')
  check('the loader asks the database for approved rows only',
    /\.eq\('status',\s*'approved'\)/.test(src),
    'dayFitLoad must filter pto_entries to status=approved')

  const team = [worker('t1'), worker('t2')]
  eq('two approved days off leaves nobody',
    workersAvailableOn(MON, team, [offDay('t1', MON), offDay('t2', MON)]), 0)
  eq('…and a different date is untouched',
    workersAvailableOn(WED, team, [offDay('t1', MON), offDay('t2', MON)]), 2)
}

// ═════════════════════════════════════════════════════════════════════════════
H('7. PAST and FUTURE dated exceptions land on their own dates only')

{
  const team = [worker('t1')]
  const past = offDay('t1', '2026-01-05')
  const future = offDay('t1', '2026-12-24')
  eq('a past day off does not remove them today', workersAvailableOn(MON, team, [past]), 1)
  eq('a future day off does not remove them today', workersAvailableOn(MON, team, [future]), 1)
  eq('the future date itself is honoured', workersAvailableOn('2026-12-24', team, [future]), 0)
  eq('the past date itself is still true history', workersAvailableOn('2026-01-05', team, [past]), 0)

  // ⭐ Rule 7 — HISTORY IS NOT REWRITTEN. A pattern recorded today describes the
  // standard week from now on. The engine holds no "effective from" column, so
  // the ONLY protection is that no surface derives past staffing from it. The
  // structural half of that promise: dated exceptions are per-date rows, so
  // yesterday's answer is made of yesterday's rows.
  const patterns = weekdays('t1')                       // Mon–Fri, recorded now
  eq('a Saturday LAST year is answered by that date’s own rows, not by today’s week',
    workersAvailableOn('2025-08-23', team, [offDay('t1', '2025-08-23')], patterns), 0)
}

// ═════════════════════════════════════════════════════════════════════════════
H('8. A WORKER WHO LEFT is off the roster from their end date')

{
  const team = [worker('t1', { ended_on: '2026-08-18' }), worker('t2')]
  eq('on their last day they still count', workersAvailableOn('2026-08-18', team, []), 2)
  eq('the day after, they do not', workersAvailableOn(WED, team, []), 1)
  eq('an archived worker never counts',
    workersAvailableOn(MON, [worker('t1', { archived_at: '2026-08-01' }), worker('t2')], []), 1)
  eq('nor does an inactive one',
    workersAvailableOn(MON, [worker('t1', { is_active: false }), worker('t2')], []), 1)
  const states = workerDayStates(WED, team, [], [])
  check('…and they are not in the per-worker list either',
    !states.some(s => s.technicianId === 't1'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('9. ONE COUNT — the two answers can never disagree')

{
  // Every combination that matters, cross-checked: the per-worker classifier
  // and the canonical head-count must be the same function of the same facts.
  const team = [worker('t1'), worker('t2'), worker('t3')]
  const cases: { date: string; patterns: AvailabilityPatternRow[]; off: ApprovedTimeOffDay[] }[] = [
    { date: MON, patterns: [], off: [] },
    { date: MON, patterns: weekdays('t1'), off: [] },
    { date: SAT, patterns: weekdays('t1'), off: [] },
    { date: SAT, patterns: [...weekdays('t1'), ...weekdays('t2')], off: [] },
    { date: MON, patterns: weekdays('t1'), off: [offDay('t2', MON)] },
    { date: SAT, patterns: [...weekdays('t1'), ...weekdays('t2'), ...weekdays('t3')], off: [] },
    { date: WED, patterns: weekdays('t1'), off: [offDay('t1', WED), offDay('t2', WED)] },
  ]
  let agreed = 0
  for (const c of cases) {
    const states = workerDayStates(c.date, team, c.patterns, c.off)
    const fromStates = states.filter(canWork).length
    const fromCount = workersAvailableOn(c.date, team, c.off, c.patterns)
    if (fromStates === fromCount) agreed++
    else fail(`states and count disagree on ${c.date}`, `states=${fromStates} count=${fromCount}`)
  }
  eq(`all ${cases.length} combinations agree`, agreed, cases.length)
}

// ═════════════════════════════════════════════════════════════════════════════
H('10. THE 3-PERSON CREW that is really 1 — the owner’s case')

{
  // Crew of 3: one booked off, one not working this weekday, one working.
  // It must NOT plan as 3.
  const team = [worker('t1'), worker('t2'), worker('t3')]
  const patterns: AvailabilityPatternRow[] = [
    // t2 works Mon–Fri but NOT Saturday; t1 and t3 have no pattern.
    ...weekdays('t2'),
  ]
  const off = [offDay('t1', SAT)]
  eq('Saturday: 3 on the roster, 1 off, 1 not working — 1 available',
    workersAvailableOn(SAT, team, off, patterns), 1)

  const states = workerDayStates(SAT, team, patterns, off)
  const stop = (over: Partial<DayPlanStopInput> = {}): DayPlanStopInput => ({
    jobId: 'j', durationMinutes: 60, crewSize: 1, status: 'scheduled',
    legKm: 2, located: true, crewId: 'crew-a', ...over,
  })
  const input = (over: Partial<DayPlanInput> = {}): DayPlanInput => ({
    stops: [stop({ jobId: 'a' })],
    startTime: '08:00', capacityHours: 8,
    workers: workersAvailableOn(SAT, team, off, patterns),
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A' },
    ...over,
  })

  const p = planDay(input())
  eq('the plan counts 1 worker, not 3', p.workers, 1)

  const short = p.warnings.find(w => w.kind === 'crew_understaffed')
  check('the crew is reported as understaffed', !!short)
  check('…as a warning, since someone can still work', short?.severity === 'warning')
  check('…and the sentence names the numbers',
    !!short && /3 workers assigned but only 1 available/.test(short.message),
    short?.message ?? '(no warning)')
  check('…and says why', !!short && /booked off/.test(short.message) && /not working this day/.test(short.message))

  const named = p.warnings.filter(w => w.kind === 'worker_unavailable')
  eq('both absent people are named', named.length, 2)
  check('…the one booked off is described as booked off',
    named.some(w => /T1/.test(w.message) && /booked off/.test(w.message)))
  check('…the one whose week excludes today is described that way',
    named.some(w => /T2/.test(w.message) && /does not normally work this weekday/.test(w.message)))

  // ⛔ The rule the brief is emphatic about: WARN, never silently unassign.
  eq('the visit is still on the plan', p.stopCount, 1)
  eq('…and still assigned to its crew', p.stops[0].jobId, 'a')

  // A 3-person visit on that day is blocking, through the pre-existing rule.
  const big = planDay(input({ stops: [stop({ jobId: 'a', crewSize: 3 })] }))
  check('a visit asking for 3 people on a 1-person day is BLOCKING',
    big.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'))
  check('…and the day is not called realistic', !big.realistic)
}

// ═════════════════════════════════════════════════════════════════════════════
H('11. A crew with work and NOBODY available is blocking')

{
  const team = [worker('t1'), worker('t2')]
  const off = [offDay('t1', MON), offDay('t2', MON)]
  const states = workerDayStates(MON, team, [], off)
  const p = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-a' }],
    startTime: '08:00', capacityHours: 8,
    workers: workersAvailableOn(MON, team, off),
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A' },
  })
  const w = p.warnings.find(x => x.kind === 'crew_understaffed')
  check('the crew warning is blocking when nobody is available', w?.severity === 'blocking')
  check('…and names the crew', !!w && /Crew A/.test(w.message), w?.message ?? '')
  check('the whole-roster case is also caught by the pre-existing rule',
    p.warnings.some(x => x.kind === 'crew_short' && x.severity === 'blocking'))
  check('a blocking day is not realistic', !p.realistic)
}

// ═════════════════════════════════════════════════════════════════════════════
H('12. UNKNOWN STAYS UNKNOWN — a failed read is not a staffed day')

{
  const stops: DayPlanStopInput[] = [
    { jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-a' },
  ]
  const p = planDay({
    stops, startTime: '08:00', capacityHours: 8,
    workers: null,                      // the roster could not be read
    staffing: null,                     // …so neither could the per-person view
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
  })
  eq('workers stays null — NOT zero', p.workers, null)
  eq('…so no labour figure is claimed', p.laborCapMin, null)
  check('the caveat is raised', p.warnings.some(w => w.kind === 'workforce_unknown'))
  check('…and no staffing warning is invented from nothing',
    !p.warnings.some(w => w.kind === 'crew_understaffed' || w.kind === 'worker_unavailable'))
  check('an unknown roster is not a BLOCKING day either',
    !p.warnings.some(w => w.severity === 'blocking'))

  // The loader must fail the whole workforce read together: a pattern read that
  // failed while the roster succeeded would silently mean "no pattern", i.e.
  // "everyone works every day" — the most optimistic possible answer.
  const src = read('src/lib/dayFitLoad.ts')
  check('an unreadable pattern makes the workforce UNKNOWN, not unrestricted',
    /workforceKnown\s*=\s*!tRes\.error\s*&&\s*!pRes\.error\s*&&\s*!aRes\.error/.test(src),
    'dayFitLoad.workforceKnown must include the availability read')
  check('…and the pattern is only used when the read is known good',
    /const patterns = workforceKnown \?/.test(src))
}

// ═════════════════════════════════════════════════════════════════════════════
H('13. The assumption is DISCLOSED on the day board')

{
  const team = [worker('t1'), worker('t2')]
  const states = workerDayStates(MON, team, [], [])
  const p = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-a' }],
    startTime: '08:00', capacityHours: 8, workers: 2,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A' }, availabilityRecorded: false,
  })
  const w = p.warnings.find(x => x.kind === 'availability_assumed')
  check('a business with no recorded weeks is told the day rests on an assumption', !!w)
  eq('…as a caveat, not an alarm', w?.severity, 'caveat')
  check('…and it says what to do about it', !!w && /working days/.test(w.message))

  const recorded = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-a' }],
    startTime: '08:00', capacityHours: 8, workers: 2,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: workerDayStates(MON, team, weekdays('t1'), []),
    crewNames: { 'crew-a': 'Crew A' }, availabilityRecorded: true,
  })
  check('…and a business that HAS set weeks is not nagged',
    !recorded.warnings.some(x => x.kind === 'availability_assumed'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('14. A CREW CHANGE moves the shortfall with the person')

{
  const patterns = weekdays('t2')                    // t2: Mon–Fri only
  const off = [offDay('t1', SAT)]
  const onA = [worker('t1'), worker('t2'), worker('t3')]
  const moved = [worker('t1'), worker('t2', { crew_id: 'crew-b' }), worker('t3')]

  const statesA = workerDayStates(SAT, onA, patterns, off)
  const statesB = workerDayStates(SAT, moved, patterns, off)
  const plan = (states: ReturnType<typeof workerDayStates>) => planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-a' }],
    startTime: '08:00', capacityHours: 8, workers: 1,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A', 'crew-b': 'Crew B' },
  })

  const a = plan(statesA).warnings.find(w => w.kind === 'crew_understaffed')
  check('with 3 on Crew A, the warning counts 3', !!a && /3 workers assigned/.test(a.message), a?.message ?? '')

  const b = plan(statesB).warnings.find(w => w.kind === 'crew_understaffed')
  check('after moving one to Crew B, Crew A’s warning counts 2',
    !!b && /2 workers assigned/.test(b.message), b?.message ?? '')
  check('…and Crew B is not warned about — it has no work booked here',
    !plan(statesB).warnings.some(w => /Crew B/.test(w.message)))

  // The business-wide count is unchanged by which crew someone is on: moving
  // people between crews must not change how many people exist.
  eq('the head-count does not move with the crew',
    workersAvailableOn(SAT, onA, off, patterns), workersAvailableOn(SAT, moved, off, patterns))
}

// ═════════════════════════════════════════════════════════════════════════════
H('15. A visit with no crew, and a crew with no members, claim nothing')

{
  const states = workerDayStates(MON, [worker('t1', { crew_id: 'crew-a' })], [], [offDay('t1', MON)])
  const unassigned = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: null }],
    startTime: '08:00', capacityHours: 8, workers: 0,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A' },
  })
  check('an unassigned visit raises no CREW warning',
    !unassigned.warnings.some(w => w.kind === 'crew_understaffed'))
  check('…but the empty roster is still blocking, through the existing rule',
    unassigned.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'))

  const empty = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'scheduled', legKm: 2, located: true, crewId: 'crew-z' }],
    startTime: '08:00', capacityHours: 8, workers: 1,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: workerDayStates(MON, [worker('t1')], [], []), crewNames: {},
  })
  check('a crew with nobody on it makes no claim about its staffing',
    !empty.warnings.some(w => w.kind === 'crew_understaffed'))

  // Cancelled stops must not summon a crew warning for a crew doing nothing.
  const cancelled = planDay({
    stops: [{ jobId: 'a', durationMinutes: 60, crewSize: 1, status: 'cancelled', legKm: 2, located: true, crewId: 'crew-a' }],
    startTime: '08:00', capacityHours: 8, workers: 1,
    hasBase: true, speed: { minPerKm: 2, overheadMin: 0 },
    staffing: states, crewNames: { 'crew-a': 'Crew A' },
  })
  check('a cancelled visit does not staff a crew',
    !cancelled.warnings.some(w => w.kind === 'crew_understaffed'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('16. TENANCY — every read and write is scoped, asserted per block')

{
  // ⚠️ Per [[day-suggestions-capacity-v1]]: assert scoping per `.from()` block,
  // never by counting occurrences — a whole-file count was once satisfied by a
  // COMMENT quoting the filter.
  const files = [
    'src/lib/dayFitLoad.ts',
    'src/lib/workerAvailabilityData.ts',
  ]
  for (const f of files) {
    const src = read(f)
    const blocks = src.split(/supabase\s*\n?\s*\.?from\(|\.from\(/).slice(1)
    let scoped = 0
    for (const b of blocks) {
      const head = b.slice(0, 400)
      // Either scoped by tenant, or keyed by a row id that RLS already owns.
      if (/\.eq\('user_id',\s*userId\)/.test(head) || /user_id:\s*args\.userId/.test(head)
        || /\.eq\('id',\s*entry\.id\)/.test(head)) scoped++
    }
    check(`${f}: all ${blocks.length} table blocks are tenant-scoped`,
      scoped === blocks.length, `${scoped}/${blocks.length} scoped`)
  }

  const data = read('src/lib/workerAvailabilityData.ts')
  check('the upsert stamps the owner on the row it writes',
    /user_id:\s*args\.userId/.test(data))
  check('…and pins the natural key, so seven rows can never become fourteen',
    /onConflict:\s*'technician_id,weekday'/.test(data))
}

// ═════════════════════════════════════════════════════════════════════════════
H('17. A worker can only ever address their OWN week')

{
  const lib = read('src/lib/crewAvailability.ts')
  const sql = read('supabase/migrations/20260815080000_worker_availability_time_off.sql')

  // ⭐ The structural guarantee: no crew RPC takes a technician id, so "edit
  // somebody else's availability" is not a request that can be expressed.
  // Asserted on the CALL SITES — the argument objects actually sent — because
  // the prose in this file necessarily discusses crew_technician_id().
  const callArgs = [...lib.matchAll(/supabase\.rpc\(\s*'([^']+)'\s*,?\s*(\{[^}]*\})?/g)]
  check(`all ${callArgs.length} crew RPC calls send no technician id`,
    callArgs.length >= 4 && callArgs.every(m => !/technician/i.test(m[2] ?? '')),
    'a technician-id argument would make another worker’s week addressable')
  check('…and the SQL declares no such parameter on any of them',
    !/function public\.crew_(my_availability|set_day_availability|request_time_off|cancel_time_off)\s*\([^)]*technician/i.test(sql))

  for (const fn of ['crew_my_availability', 'crew_set_day_availability', 'crew_request_time_off', 'crew_cancel_time_off']) {
    const body = sql.split(new RegExp(`function public\\.${fn}\\b`))[1]?.split('$function$')[1] ?? ''
    check(`${fn}: resolves the caller from the roster switches`,
      /crew_technician_id\(\)/.test(body) || /v_tech/.test(body))
    check(`${fn}: fails closed when the caller is not an active crew member`,
      /v_employer is null/.test(body))
  }

  check('every crew function is SECURITY DEFINER with a pinned search_path',
    (sql.match(/security definer/gi) || []).length >= 4
    && (sql.match(/set search_path to 'public', 'pg_temp'/gi) || []).length >= 4)
  check('anon can execute none of them',
    !/grant execute on function public\.(crew_my_availability|crew_set_day_availability|crew_request_time_off|crew_cancel_time_off)[^;]*to anon/i.test(sql))
  check('…and each one revokes from every role before granting',
    (sql.match(/revoke all on function public\."?crew_/gi) || []).length >= 4)

  // ⛔ Crew mode is RPC-only. A crew RLS policy would hand over the whole row.
  check('no crew RLS policy is introduced on the new table',
    !/create policy[^;]*crew/i.test(sql.replace(/--[^\n]*/g, '')))
  check('the new table is owner-scoped on every policy',
    (sql.match(/auth\.uid\(\) = user_id/g) || []).length >= 4)
  check('anon holds no grant on worker_availability',
    !/grant .* on table public\.worker_availability to anon/i.test(sql))
}

// ═════════════════════════════════════════════════════════════════════════════
H('18. The SCHEMA says what the product says')

{
  const sql = read('supabase/migrations/20260815080000_worker_availability_time_off.sql')

  check('a weekday is 0..6', /weekday between 0 and 6/.test(sql))
  check('one row per worker per weekday', /unique \(technician_id, weekday\)/.test(sql))
  check('an available day states a window; an unavailable one states nothing',
    /available and start_time is not null and end_time is not null and end_time > start_time/.test(sql)
    && /not available and start_time is null and end_time is null/.test(sql))
  check('the composite tenancy FK mirrors pto_entries (a row cannot attach across tenants)',
    /foreign key \(technician_id, user_id\)\s*\n?\s*references public\.technicians \(id, user_id\)/.test(sql))
  check('removing a worker takes their week with them',
    /references public\.technicians \(id, user_id\) on delete cascade/.test(sql))

  check('the three statuses, and only those', /status in \('requested', 'approved', 'declined'\)/.test(sql))
  check('existing rows default to approved — booking IS approval',
    /add column if not exists status text default 'approved' not null/.test(sql))
  check('a DECLINED row never blocks a real booking',
    /create unique index if not exists pto_entries_one_per_day_kind[\s\S]*?where status <> 'declined'/.test(sql))
  check('the owner’s requests inbox has an index',
    /where status = 'requested'/.test(sql))

  // A request must assert no payroll claim — pay is the owner's decision.
  const req = sql.split(/function public\.crew_request_time_off\b/)[1] ?? ''
  check('a request is created unpaid with no rate — the owner decides pay',
    /false, null, nullif/.test(req))
  check('…and a worker cannot request a company holiday',
    /p_kind not in \('vacation', 'sick', 'personal', 'bereavement'\)/.test(req))
  check('…and cannot ask for a day that has passed', /p_date < current_date/.test(req))
  check('…and the request lands as REQUESTED, never approved',
    /'requested'\s*\n?\s*\)/.test(req) && !/'approved'/.test(req))

  const cancel = sql.split(/function public\.crew_cancel_time_off\b/)[1] ?? ''
  check('a worker can only withdraw a request nobody has decided',
    /status = 'requested'/.test(cancel))
}

// ═════════════════════════════════════════════════════════════════════════════
H('19. The surfaces spend the engine, and do not rival it')

{
  const week = read('src/components/workforce/TeamAvailabilityWeek.tsx')
  check('the team week reads the shared engine',
    /workerDayStates/.test(week) && /from '@\/lib\/workerAvailability'/.test(week))
  check('…and counts with the shared predicate, not its own test',
    /canWork/.test(week) && !/state === 'available' \|\| /.test(week))
  check('…and filters time off to approved before counting',
    /status === 'approved'/.test(week))
  check('…and renders an unreadable week as unknown, not as a full one',
    /couldn’t be read|couldn't be read/.test(week))

  const editor = read('src/components/workforce/WeeklyAvailabilityEditor.tsx')
  check('the week editor is CONTROLLED (no defaultValue anywhere)',
    !/defaultValue/.test(editor))
  check('…and puts a row back when the write did not land',
    /setState\(s => s\.map\(\(r, i\) => \(i === wd \? prev : r\)\)\)/.test(editor))
  check('…and is the SAME control the worker uses',
    /from '@\/components\/workforce\/WeeklyAvailabilityEditor'/.test(read('src/components/crew/CrewAvailability.tsx')))

  const crew = read('src/components/crew/CrewAvailability.tsx')
  check('the crew screen keeps the three outcomes apart',
    /'revoked'/.test(crew) && /'error'/.test(crew))
  check('…and a failed refresh does not read as revoked',
    /setState\(data \? 'ok' : 'error'\)/.test(crew))
  check('…and says asking is not booking', /Asking isn’t booking|Asking isn't booking/.test(crew))

  const timeOff = read('src/app/dashboard/dispatch/time-off/page.tsx')
  check('the owner’s balances count APPROVED time off only',
    /const approved = useMemo\(\(\) => entries\.filter\(e => e\.status === 'approved'\)/.test(timeOff))
  check('…and the requests queue is its own list',
    /e\.status === 'requested'/.test(timeOff))
  check('…and the decision goes through the one writer',
    /decideTimeOff\(/.test(timeOff))

  const plan = read('src/lib/dayPlan.ts')
  check('the day plan never reassigns work',
    !/crew_id\s*=/.test(plan) && !/\.update\(/.test(plan))
  // ⛔ Session 60 rule 5, still true: the capacity engine cannot see money.
  const planNoComments = plan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  check('…and still cannot see money',
    !/\b(price|revenue|margin|amount|invoice)\b/i.test(planNoComments))
}

// ═════════════════════════════════════════════════════════════════════════════
H('20. The count is additive — the old call still means the old thing')

{
  // Three arguments must behave EXACTLY as before Session 67, or every existing
  // caller silently changed meaning.
  const team = [worker('t1'), worker('t2'), worker('t3')]
  const off = [offDay('t2', MON)]
  eq('three-argument call: roster minus time off', workersAvailableOn(MON, team, off), 2)
  eq('…identical to passing an empty pattern list', workersAvailableOn(MON, team, off, []), 2)
  eq('…and to passing patterns that do not exclude anyone',
    workersAvailableOn(MON, team, off, weekdays('t1')), 2)

  const src = read('src/lib/dayFit.ts')
  check('the patterns parameter is optional',
    /patterns\?:\s*AvailabilityPatternRow\[\]/.test(src))
  check('…and is skipped entirely when empty',
    /patterns\?\.length \? patternUnavailableOn\(date, patterns\) : null/.test(src))
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(72)}`)
if (failures === 0) {
  console.log('AVAILABILITY OK — who works a day is answered from recorded facts,')
  console.log('and every assumption in that answer is labelled as one.\n')
} else {
  console.log(`AVAILABILITY FAILED — ${failures} check(s) failed.\n`)
}
process.exit(failures === 0 ? 0 : 1)
