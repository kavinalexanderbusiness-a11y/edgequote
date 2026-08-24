// ── Verify: the worker's field home tells the truth ──────────────────────────
//   npm run verify:field-home
//
// Grown out of verify:crew-brief (Session 61): the brief's change-honesty rules
// are still the heart of it, and the file now also pins the FIELD HOME surface
// claims — where a worker lands, what the header answers, which exits from the
// clock exist, and what the offline shell may hold. The deeper boundaries this
// surface stands on are pinned by their own guards and deliberately not
// restated here: crew-access (RPC-only access), work-sessions (the one-number
// clock), completion (proof of work), scoped-notes (audience), crew-messages
// (chat), day-plan (the owner's mirror of crew order).
//
// WHY THIS SCRIPT EXISTS
// "What changed since you looked" is the one answer on a field screen that
// cannot be checked by looking at it. Every other line on Today is falsifiable
// in the driveway — the address is right or the customer is not there, the
// gate code works or it does not. A change banner is different: it is a claim
// about a PAST state that nothing on the phone still holds, so a wrong one is
// invisible, and there are exactly two ways to be wrong:
//
//   TOO LOUD — report churn (a row version, the worker's own Start tap, an
//     index that shifted because a stop above it was cancelled). A banner that
//     cries wolf every morning is dismissed unread, and the cancellation that
//     mattered goes with it. This is the failure mode that kills the feature
//     without ever looking broken.
//   TOO QUIET — miss a cancellation, a moved hour or a rewritten gate code, or
//     silently consume one when the phone re-read itself on a five-minute timer
//     while face-down on the truck seat.
//
// Neither shows up in tsc, in `next build`, or on screen. So every rule
// lib/crewBrief documents is RUN here, and the privacy and reuse claims the
// feature makes are asserted over the real source and the real database.
//
// ⭐ NO FIXTURE TENANT, NO LIVE BOOK. The engine is pure, so its rules are
// pinned by calling it — no rows are written anywhere. The database facts the
// feature depends on are read from the repo's OWN migrations (the last
// definition of crew_day on disk), a statement about the schema as versioned
// here — not about anybody's data, and not about a hand-applied prod-only
// definition, which this guard cannot see. Guards that assert over live
// production rows are coin flips (guard-fixtures-not-the-book); this one has
// nothing to flip.

import {
  crewDaySnapshot, diffCrewDay, crewOrderBasis, textMark,
  type CrewDaySnapshot, type CrewChange, type CrewChangeKind,
} from '../src/lib/crewBrief'
import { routeFor, type CrewDay, type CrewStop } from '../src/lib/crewAccess'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
/**
 * ⚠️ NEWLINES ARE NORMALISED, and this is not cosmetic. Every source file in
 * this checkout is CRLF (`git stash`/`pop` alone converts LF→CRLF on Windows),
 * `.` does not match `\r`, and an `indexOf` for a marker written with `\n`
 * returns -1. This guard's first run failed exactly that way: the slice bound
 * missed, `slice(start, -1)` returned nearly the whole file, and a correct
 * CrewToday was reported as writing the baseline from its refresh path.
 *
 * A guard that fails on line endings is bad; the same bug in the other
 * direction — a match that silently never fires, so the rule is never actually
 * checked — is much worse, and would look like a passing suite forever.
 */
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const kinds = (cs: CrewChange[]): CrewChangeKind[] => cs.map(c => c.kind)
const has = (cs: CrewChange[], k: CrewChangeKind, jobId?: string) =>
  cs.some(c => c.kind === k && (jobId === undefined || c.jobId === jobId))

// ── A day, as crew_day returns it ────────────────────────────────────────────
// Shaped by hand so each test states exactly one difference. The stops arrive
// in the RPC's order; nothing here re-sorts them, which is the contract.

let seq = 0
function stop(over: Partial<CrewStop> = {}): CrewStop {
  seq++
  return {
    id: over.id ?? `job-${seq}`,
    title: 'Weekly service',
    service_type: 'Lawn maintenance',
    scheduled_date: '2026-08-14',
    start_time: null,
    duration_minutes: 45,
    crew_size: 1,
    status: 'scheduled',
    started_at: null,
    completed_at: null,
    actual_minutes: null,
    on_my_way_at: null,
    route_order: null,
    updated_at: '2026-08-14T12:00:00Z',
    notes: null,
    completion_summary: null,
    completion_issue: null,
    customer: { name: 'A Customer', phone: '555-0100' },
    property: { address: '1 Main St', lat: 51, lng: -114 },
    ...over,
  }
}
function day(stops: CrewStop[], over: Partial<CrewDay> = {}): CrewDay {
  return {
    date: '2026-08-14',
    me: { id: 'tech-1', name: 'Sam', role: 'Technician', status: 'active' },
    crew: { id: 'crew-1', name: 'Crew A', color: '#0af', day_start: '08:00' },
    business: { name: 'EdgeHQ', phone: null, work_start_time: '08:00' },
    teammates: [],
    day_note: null,
    crew_note: null,
    stops,
    ...over,
  }
}
const snap = (d: CrewDay, unread: Record<string, number> = {}) => crewDaySnapshot(d, unread, 1)

console.log('\n── 1. No baseline, no claims ──────────────────────────────────')
// ⭐ THE RULE THAT PROTECTS EVERY OTHER ONE. A phone that has just cleared its
// storage must open on an ordinary morning, not on "8 changes". Get this wrong
// and the banner is noise from the first install, permanently.
{
  const d = day([stop({ id: 'a' }), stop({ id: 'b' }), stop({ id: 'c' })])
  check('a first open reports nothing at all', diffCrewDay(null, snap(d)).length === 0,
    `got ${JSON.stringify(kinds(diffCrewDay(null, snap(d))))}`)
}
{
  // Honesty rule 2, both halves. A diff across days or across workers is not a
  // conservative answer — it is a meaningless one, and it would arrive on a
  // shared handset looking exactly like a real alert.
  const mine = snap(day([stop({ id: 'a' })]))
  const otherDay: CrewDaySnapshot = { ...mine, date: '2026-08-13' }
  const otherTech: CrewDaySnapshot = { ...mine, techId: 'tech-2' }
  const next = snap(day([stop({ id: 'z' })]))
  check('yesterday is not a baseline for today', diffCrewDay(otherDay, next).length === 0)
  check("another worker's day is not a baseline", diffCrewDay(otherTech, next).length === 0)
  check('an unrecognised snapshot version is discarded, not migrated',
    diffCrewDay({ ...mine, v: 99 as unknown as 1 }, next).length === 0)
}

console.log('\n── 2. The schedule moved ──────────────────────────────────────')
{
  const before = snap(day([stop({ id: 'a' }), stop({ id: 'b' }), stop({ id: 'c' })]))
  // Same three stops, driven in a different sequence.
  const after = snap(day([stop({ id: 'c' }), stop({ id: 'a' }), stop({ id: 'b' })]))
  const cs = diffCrewDay(before, after)
  check('a reordered day is reported', cs.some(c => c.kind === 'moved'), JSON.stringify(kinds(cs)))
  check('three stops changing places is ONE line, not three',
    cs.filter(c => c.kind === 'moved').length === 1, JSON.stringify(cs.filter(c => c.kind === 'moved')))
}
{
  // ⭐⭐ HONESTY RULE 5, the one that separates a useful banner from noise.
  // Cancelling the FIRST stop shifts every index below it. Comparing raw
  // positions would report two stops as "moved" that nobody touched — and the
  // real news (a cancellation) would arrive buried in two false alarms.
  const before = snap(day([stop({ id: 'a' }), stop({ id: 'b' }), stop({ id: 'c' })]))
  const after = snap(day([
    stop({ id: 'a', status: 'cancelled' }), stop({ id: 'b' }), stop({ id: 'c' }),
  ]))
  const cs = diffCrewDay(before, after)
  check('a cancellation does not manufacture "moved" for the stops below it',
    !has(cs, 'moved'), JSON.stringify(kinds(cs)))
  check('…and the cancellation itself is reported', has(cs, 'cancelled', 'a'), JSON.stringify(kinds(cs)))
}
{
  // The same trap from the other direction: an INSERTED stop at the top.
  const before = snap(day([stop({ id: 'b' }), stop({ id: 'c' })]))
  const after = snap(day([stop({ id: 'new' }), stop({ id: 'b' }), stop({ id: 'c' })]))
  const cs = diffCrewDay(before, after)
  check('an added stop does not manufacture "moved" for the stops it pushed down',
    !has(cs, 'moved'), JSON.stringify(kinds(cs)))
  check('…and the addition itself is reported', has(cs, 'added', 'new'))
}
{
  const before = snap(day([stop({ id: 'a' }), stop({ id: 'b' })]))
  // Gone from the payload: rescheduled to another day, or given to another crew.
  const after = snap(day([stop({ id: 'a' })]))
  const cs = diffCrewDay(before, after)
  check('a stop that left the day is reported — nothing else can say so', has(cs, 'removed', 'b'))
  check('"removed" outranks everything: it is the line that saves a wasted trip',
    cs[0].kind === 'removed', JSON.stringify(kinds(cs)))
}
{
  const before = snap(day([stop({ id: 'a', start_time: '09:00' })]))
  const after = snap(day([stop({ id: 'a', start_time: '13:30' })]))
  const cs = diffCrewDay(before, after)
  check('a moved hour is reported', has(cs, 'time', 'a'))
  check('…and it says both hours, so the worker need not remember the old one',
    /9:00 am → 1:30 pm/.test(cs.find(c => c.kind === 'time')?.detail ?? ''),
    cs.find(c => c.kind === 'time')?.detail ?? '(none)')
}
{
  // A cancelled stop's hour and instructions are moot. Reporting them beside
  // "cancelled" is three lines about a visit that is not happening.
  const before = snap(day([stop({ id: 'a', start_time: '09:00', notes: 'Gate code 1942' })]))
  const after = snap(day([stop({ id: 'a', status: 'cancelled', start_time: '13:00', notes: 'ignore' })]))
  const cs = diffCrewDay(before, after)
  check('a cancelled stop reports the cancellation and nothing else',
    kinds(cs).join(',') === 'cancelled', JSON.stringify(kinds(cs)))
}

console.log('\n── 3. Instructions, notes and messages ────────────────────────')
{
  const before = snap(day([stop({ id: 'a', notes: 'Gate code 1942' })]))
  const after = snap(day([stop({ id: 'a', notes: 'Gate code 1943 — dog in the yard' })]))
  check('a rewritten site instruction is reported', has(diffCrewDay(before, after), 'instruction', 'a'))
}
{
  // LONG INSTRUCTIONS. Two things must hold at once: the change is still
  // detected, and the baseline does not grow without bound — a season of
  // multi-kilobyte instructions per stop per day would eventually fail the
  // localStorage write for the day that matters. Hence a hash, not the text.
  const long = 'A'.repeat(20_000)
  const before = snap(day([stop({ id: 'a', notes: long })]))
  const after = snap(day([stop({ id: 'a', notes: long + ' and one more thing' })]))
  check('a change at the END of a 20k-character instruction is still caught',
    has(diffCrewDay(before, after), 'instruction', 'a'))
  check('the baseline stores a mark, not the instruction text',
    JSON.stringify(before).length < 1000 && !JSON.stringify(before).includes('AAAA'),
    `snapshot was ${JSON.stringify(before).length} bytes`)
  check('identical long text is not a change', diffCrewDay(before, snap(day([stop({ id: 'a', notes: long })]))).length === 0)
  // Whitespace-only edits are not news to a worker.
  check('re-saving an instruction with different surrounding whitespace is not a change',
    textMark('  Gate code 1942  ') === textMark('Gate code 1942'))
}
{
  const before = snap(day([stop({ id: 'a' })], { day_note: 'Rain expected', crew_note: null }))
  const after = snap(day([stop({ id: 'a' })], { day_note: 'Rain expected', crew_note: 'Truck 2 is in the shop' }))
  const cs = diffCrewDay(before, after)
  check("a new note to this worker's crew is reported", has(cs, 'crew_note'))
  check('…and the UNCHANGED day-wide note is not', !has(cs, 'day_note'), JSON.stringify(kinds(cs)))
}
{
  // NEW CREW MESSAGE. The counts are the server's (crew_message_inbox), so this
  // reports what the SERVER still considers unread — not what this device
  // forgot seeing.
  const d = day([stop({ id: 'a' })])
  const before = snap(d, { a: 0 })
  const after = snap(d, { a: 2 })
  const cs = diffCrewDay(before, after)
  check('new messages on a visit are reported', has(cs, 'message', 'a'))
  check('…and the count is the NEW ones, not the total',
    /2 new messages/.test(cs.find(c => c.kind === 'message')?.detail ?? ''),
    cs.find(c => c.kind === 'message')?.detail ?? '(none)')
  check('reading messages (the count falling) is not a change',
    diffCrewDay(snap(d, { a: 3 }), snap(d, { a: 0 })).length === 0)
}

console.log('\n── 3b. Who the worker is with ─────────────────────────────────')
// "Crew A, with Sarah and Mike" is read once at sign-in and then trusted all
// day. When the office moves people between crews mid-morning, the header
// silently re-renders — the same silent-refetch problem the whole brief exists
// for, applied to people instead of stops.
{
  const mates = (ts: { id: string; name: string }[]) =>
    day([stop({ id: 'a' })], { teammates: ts.map(t => ({ ...t, role: null })) })
  const before = snap(mates([]))
  const joined = snap(mates([{ id: 't2', name: 'Sarah' }]))
  const cs = diffCrewDay(before, joined)
  check('a teammate joining the crew is reported', has(cs, 'crew'), JSON.stringify(kinds(cs)))
  check('…and the line says who the worker is with NOW',
    /now with Sarah/.test(cs.find(c => c.kind === 'crew')?.detail ?? ''),
    cs.find(c => c.kind === 'crew')?.detail ?? '(none)')
  const alone = diffCrewDay(joined, before)
  check('a teammate leaving is reported as working solo',
    /working solo/.test(alone.find(c => c.kind === 'crew')?.detail ?? ''),
    JSON.stringify(alone))
}
{
  // Identity is the SET of ids. A rename is the office fixing a typo; a
  // reordered payload is JSON, not a staffing decision. Neither is news.
  const withMates = (ts: { id: string; name: string }[]) =>
    snap(day([stop({ id: 'a' })], { teammates: ts.map(t => ({ ...t, role: null })) }))
  check('a renamed teammate is not a crew change',
    diffCrewDay(withMates([{ id: 't2', name: 'Sara' }]), withMates([{ id: 't2', name: 'Sarah' }])).length === 0)
  check('the same people in a different payload order is not a crew change',
    diffCrewDay(
      withMates([{ id: 't2', name: 'Sarah' }, { id: 't3', name: 'Mike' }]),
      withMates([{ id: 't3', name: 'Mike' }, { id: 't2', name: 'Sarah' }]),
    ).length === 0)
}
{
  // Moved to a DIFFERENT crew with the same teammates: the crew id is part of
  // identity — a different crew has a different note, a different board and a
  // different day_start, and the worker should know they were moved.
  const onCrew = (crewId: string) =>
    snap(day([stop({ id: 'a' })], { crew: { id: crewId, name: 'Crew', color: '#0af', day_start: '08:00' } }))
  check('being moved to another crew is reported', has(diffCrewDay(onCrew('crew-1'), onCrew('crew-2')), 'crew'))
}
{
  // ⭐ THE LEGACY BASELINE. Snapshots saved by the build BEFORE these fields
  // existed are still on phones. Absent fields make NO crew claims — the same
  // "no baseline ⇒ no claims" rule, per field. Announcing "your crew changed"
  // to every worker on deploy morning would spend the feature's credibility on
  // a version skew.
  const now = snap(day([stop({ id: 'a' })], { teammates: [{ id: 't2', name: 'Sarah', role: null }] }))
  const legacy = { ...now } as CrewDaySnapshot
  delete legacy.crewId
  delete legacy.mateIds
  delete legacy.mateNames
  const cs = diffCrewDay(legacy, now)
  check('a baseline that never recorded the crew makes no crew claims',
    !has(cs, 'crew'), JSON.stringify(kinds(cs)))
}
{
  // Severity: a crew change matters like a sequence change (it changes how the
  // day is worked) but must never outrank a wasted trip.
  const before = snap(day([stop({ id: 'a' }), stop({ id: 'b' })]))
  const after = snap(day([stop({ id: 'b' })], { teammates: [{ id: 't2', name: 'Sarah', role: null }] }))
  const order = kinds(diffCrewDay(before, after))
  check('a removed stop still outranks a crew change',
    order.indexOf('removed') !== -1 && order.indexOf('removed') < order.indexOf('crew'),
    JSON.stringify(order))
}

console.log('\n── 4. ⛔ What must NEVER be reported ──────────────────────────')
// The whole feature turns on this section. Every line here is a mutation that
// really does happen, really does move jobs.updated_at, and must produce no
// banner — because it is the worker's own tap coming back from the server.
{
  const base = stop({ id: 'a' })
  const before = snap(day([base]))

  // WORK SESSION STARTED. Start → in_progress + started_at, and the row version
  // moves. If this reported, every single tap would raise a banner about itself.
  const started = snap(day([{ ...base, status: 'in_progress', started_at: '2026-08-14T14:00:00Z', updated_at: '2026-08-14T14:00:00Z' }]))
  check('starting a visit reports nothing', diffCrewDay(before, started).length === 0,
    JSON.stringify(kinds(diffCrewDay(before, started))))

  // Done for today: the session banks, the visit stays open (work-sessions v1).
  const stopped = snap(day([{ ...base, status: 'in_progress', started_at: null, actual_minutes: 90, updated_at: '2026-08-14T16:00:00Z' }]))
  check('stopping for the day reports nothing', diffCrewDay(before, stopped).length === 0,
    JSON.stringify(kinds(diffCrewDay(before, stopped))))

  const finished = snap(day([{ ...base, status: 'completed', completed_at: '2026-08-14T15:00:00Z', actual_minutes: 60, updated_at: '2026-08-14T15:00:00Z' }]))
  check('finishing a visit reports nothing', diffCrewDay(before, finished).length === 0,
    JSON.stringify(kinds(diffCrewDay(before, finished))))

  const recorded = snap(day([{ ...base, completion_summary: 'Mowed and edged', completion_issue: 'Sprinkler head leaking', updated_at: '2026-08-14T15:05:00Z' }]))
  check('writing the completion record reports nothing', diffCrewDay(before, recorded).length === 0,
    JSON.stringify(kinds(diffCrewDay(before, recorded))))

  const touched = snap(day([{ ...base, updated_at: '2026-08-14T23:59:00Z', on_my_way_at: '2026-08-14T13:00:00Z' }]))
  check('a bare row-version bump reports nothing — updated_at is not an event',
    diffCrewDay(before, touched).length === 0, JSON.stringify(kinds(diffCrewDay(before, touched))))
}
{
  // An unchanged day, re-read on the five-minute timer. The commonest call by
  // far, and it must be silent.
  const d = day([stop({ id: 'a', notes: 'Gate code 1942' }), stop({ id: 'b' })], { day_note: 'Rain' })
  check('re-reading an unchanged day reports nothing', diffCrewDay(snap(d), snap(d)).length === 0)
}

console.log('\n── 5. Whose order is the numbered list? ───────────────────────')
// ⭐⭐ THE SESSION 60 RECONCILIATION. crew_day sorts by
// coalesce(route_order,999999), coalesce(start_time,'99:99'), created_at — so
// with neither key set the list is the order the visits were BOOKED in. On
// production 2026-08-14 that is 7 of 175 jobs carrying a route_order and 1 of
// 175 a start_time: nearly every day. The numbers are still useful; the claim
// that somebody CHOSE them is not.
{
  check('a day nobody ordered is "booked"',
    crewOrderBasis([stop({ id: 'a' }), stop({ id: 'b' })]) === 'booked')
  check('one hand-dragged position makes the day "planned"',
    crewOrderBasis([stop({ id: 'a', route_order: 1 }), stop({ id: 'b' })]) === 'planned')
  check('one committed hour makes the day "planned"',
    crewOrderBasis([stop({ id: 'a', start_time: '09:00' }), stop({ id: 'b' })]) === 'planned')
  check('a single stop has no sequence to have a basis',
    crewOrderBasis([stop({ id: 'a' })]) === 'none')
  check('cancelled stops cannot make a day look planned',
    crewOrderBasis([
      stop({ id: 'a', status: 'cancelled', route_order: 1 }), stop({ id: 'b' }), stop({ id: 'c' }),
    ]) === 'booked')
}
{
  // ⛔ THE HARD ONE: this screen must never grow a second route algorithm.
  // lib/route owns ordering for the owner's board and the RPC owns it for the
  // phone; a third would be a third answer to "what is stop one?".
  const BRIEF = read('src/lib/crewBrief.ts')
  // Two sorts are legitimate and neither is a stop order: the severity sort on
  // the way out (changes, not stops) and the teammate-ID canonicalisation in
  // the snapshot (a SET compared as a string — sorting ids is what makes "same
  // people, different payload order" a non-change). Anything else is suspect.
  check('the brief engine never sorts the day',
    !/\.sort\(/.test(
      BRIEF
        .replace(/return out\.sort\([\s\S]*?\)\n\}/, '')
        .replace(/day\.teammates\.map\(t => t\.id\)\.sort\(\)/, ''),
    ),
    'lib/crewBrief must not re-order stops — crew_day owns the sequence')
  const TODAY = read('src/components/crew/CrewToday.tsx')
  check('Today renders the stops in the order the RPC returned them',
    !/\.sort\(/.test(TODAY), 'CrewToday must not sort — the RPC and lib/fieldStops own order')
  check('the order disclosure is driven by the engine, not a hand-written condition',
    /crewOrderBasis\(/.test(TODAY) && /orderBasis === 'booked'/.test(TODAY))
}

console.log('\n── 6. Privacy: what a baseline is allowed to hold ─────────────')
// A crew session already cannot READ money (crew_day selects no price column).
// The new surface is the DEVICE: a snapshot is written to localStorage on a
// phone that gets shared, lost and sold. It must hold the least that answers
// "did this change" — and the marks are one-way, so even the instruction text
// is not recoverable from it.
{
  const d = day([stop({
    id: 'a', notes: 'Gate code 1942', customer: { name: 'A Customer', phone: '555-0100' },
    property: { address: '1 Main St', lat: 51, lng: -114 },
  })])
  const s = JSON.stringify(snap(d))
  check('a baseline holds no address', !s.includes('Main St'), s)
  check('a baseline holds no phone number', !s.includes('555-0100'), s)
  check('a baseline holds no instruction text', !s.includes('1942'), s)
  check('a baseline holds no coordinates', !s.includes('-114'), s)
  const BRIEF = read('src/lib/crewBrief.ts')
  check('the snapshot reads no money field',
    !/\b(price|total|amount|cost|margin|revenue|balance)\b/.test(
      BRIEF.slice(BRIEF.indexOf('export function crewDaySnapshot'))),
    'lib/crewBrief must not read a money field — crew_day does not even return one')
}
{
  // PRIVATE MEDIA. The office's reference photos are minted as signed URLs at
  // the moment a worker opens one, and a signature taken at 7am is dead by the
  // eighth stop. A change detector that cached them on the device would both
  // outlive its own signature and put customer property photos in localStorage.
  const BRIEF = read('src/lib/crewBrief.ts')
  check('the brief engine never touches media, signed URLs or storage paths',
    !/\b(media|photo|signed|storage|bucket|url)\b/i.test(
      BRIEF.slice(BRIEF.indexOf('export interface CrewStopMark'))),
    'the baseline must hold no media reference of any kind')
  const STORE = read('src/lib/crewBriefStore.ts')
  check('the device store holds only the snapshot',
    !/\b(photo|media|signed|address|phone)\b/i.test(
      STORE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'lib/crewBriefStore must persist nothing beyond the snapshot')
}

console.log('\n── 7. The baseline advances on acknowledgement ONLY ───────────')
// ⭐ HONESTY RULE 3, and the one a refactor is most likely to undo — writing the
// baseline in `load()` looks tidier and is silently wrong. Today re-reads itself
// on focus, on reconnect and every five minutes; a baseline that moved with it
// would consume the office's schedule change while the phone lay face-up on the
// truck seat, and the worker would drive the old day.
{
  const TODAY = read('src/components/crew/CrewToday.tsx')
  const STORE = read('src/lib/crewBriefStore.ts')
  const writes = TODAY.split('writeCrewDayBaseline(').length - 1
  check('the baseline is written in exactly two places (first-open seed, and "Got it")',
    writes === 2, `found ${writes} writeCrewDayBaseline calls`)
  check('the acknowledgement handler is what the banner calls',
    /onDismiss=\{acknowledgeChanges\}/.test(TODAY) &&
    /acknowledgeChanges = useCallback\(\(\) => \{[\s\S]{0,220}writeCrewDayBaseline\(snapshot\)/.test(TODAY))
  // The load() path re-reads the day. It must not carry a baseline write.
  // ⚠️ The bounds are asserted BEFORE the rule that uses them: a marker that
  // stopped matching would make `slice` return the wrong region, and the rule
  // would then be checked against text it was never about — passing forever
  // while the real load() quietly grew a write.
  const loadStart = TODAY.indexOf('const load = useCallback')
  const loadEnd = TODAY.indexOf('useEffect(() => {\n    alive.current = true')
  check('the refresh path can be located at all', loadStart >= 0 && loadEnd > loadStart,
    `load() bounds not found (start=${loadStart}, end=${loadEnd}) — this check is not running`)
  if (loadStart >= 0 && loadEnd > loadStart) {
    check('the refresh path never writes a baseline',
      !/writeCrewDayBaseline/.test(TODAY.slice(loadStart, loadEnd)),
      'load() runs on a 5-minute timer — writing there consumes changes nobody saw')
  }
  check('a first open seeds the baseline only when nothing is stored',
    /const stored = readCrewDayBaseline\([\s\S]{0,120}if \(stored\) \{[\s\S]{0,80}\} else \{[\s\S]{0,120}writeCrewDayBaseline\(snapshot\)/.test(TODAY))
  check('every read failure returns null, which the engine turns into no claims',
    (STORE.match(/catch \{ return null \}/g) || []).length >= 2)
}
{
  // Rule 4: only an `ok` day may become a baseline. The seed effect is gated on
  // `day`, which the stale and offline branches never set.
  const TODAY = read('src/components/crew/CrewToday.tsx')
  check('a failed load cannot become a baseline',
    /if \(baselineReady \|\| !day \|\| !snapshot\) return/.test(TODAY),
    'the seed must be gated on a loaded day, not on the render')
}

console.log('\n── 8. The three database facts the brief stands on ────────────')
// Read from the CATALOGUE, not from anybody's rows: these are statements about
// the schema, true whatever the book happens to contain today.
{
  // The authorization the brief inherits — asserted against the migration that
  // defines it, so a rewrite of crew_day that drops a filter fails here.
  //
  // The LAST definition wins: crew_day has been redefined several times (the
  // completion record, the cancelled-stop payload), and the guard must read the
  // one that is actually in force, not the first one it happens to find.
  const SQL = (() => {
    const dirs = ['supabase/archive/ledger', 'supabase/archive/run', 'supabase/migrations']
    let best = ''
    for (const d of dirs) {
      const p = join(ROOT, d)
      if (!existsSync(p)) continue
      for (const f of readdirSync(p).sort()) {
        const body = readFileSync(join(p, f), 'utf8')
        if (/create or replace function public\.crew_day/i.test(body)) best = body
      }
    }
    return best
  })()
  check('the crew_day definition is in the repo at all', SQL.length > 0,
    'no migration defines crew_day — the brief cannot state what it is authorised by')
  if (SQL) {
    const body = SQL.slice(SQL.toLowerCase().indexOf('create or replace function public.crew_day'))
    // ASSIGNED WORKER / UNASSIGNED WORK. A visit with no crew_id reaches nobody's
    // phone, however the day is ordered.
    // Session 65 moved this from a direct `j.crew_id = v_crew` test to an
    // assignment model — a stop belongs to a CREW or to a PERSON — expressed as
    // crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech), whose
    // body is `coalesce(j_crew = v_crew, false) or coalesce(j_technician = v_tech, false)`.
    // The property this check exists for is unchanged: a visit assigned to NEITHER
    // still coalesces to false on both halves and so reaches nobody's phone.
    check('crew_day returns only stops assigned to the caller\'s crew or to them',
      /crew_assignment_covers\(\s*j\.crew_id,\s*j\.technician_id,\s*v_crew,\s*v_tech\s*\)/.test(body),
      'without this an unassigned job would appear on a crew phone')
    // TENANT ISOLATION. The employer is derived server-side from the session.
    check('crew_day is scoped to the caller\'s employer',
      /j\.user_id\s*=\s*v_employer/.test(body) && /v_employer\s+uuid\s*:=\s*public\.crew_employer\(\)/.test(body),
      'the tenant must come from the session, never from a parameter')
    // DEACTIVATED WORKER. crew_employer() is null once the technician is
    // inactive or archived, and the function returns SQL null — which
    // loadCrewDay maps to 'revoked', never to an empty day.
    check('a caller with no employer gets null, not an empty day',
      /if v_employer is null then\s*return null;/i.test(body),
      'an empty day would read as "nothing booked" to a revoked worker')
    // NO MONEY. The brief's privacy claim starts here: the column never crosses
    // the wire, so no client bug can leak it.
    const stopsBlock = body.slice(body.indexOf("'stops'"))
    check('crew_day selects no money column',
      !/\bj\.(price|total|amount|cost|deposit|balance)\b/.test(stopsBlock),
      'a money column in the crew payload would be visible to every worker')
    check('the order the phone shows is the RPC\'s own',
      /order by x\.route_rank,\s*x\.start_key,\s*x\.created_at/i.test(body),
      'lib/crewBrief.crewOrderBasis documents exactly this ORDER BY')
  }
}

console.log('\n── 9. Mobile: the banner cannot push the day off the screen ───')
{
  const CH = read('src/components/crew/CrewChanges.tsx')
  check('the change list is capped', /const MAX_LINES = \d/.test(CH))
  check('…and truncates from the BOTTOM, so a cancellation is never the line hidden',
    /changes\.slice\(0, MAX_LINES\)/.test(CH) && /SEVERITY/.test(read('src/lib/crewBrief.ts')))
  check('long names wrap instead of scrolling the page sideways',
    /break-words/.test(CH) && /min-w-0/.test(CH))
  check('the acknowledgement is a real tap target', /tap-target/.test(CH))
  check('a removed stop is not a button that scrolls to nothing',
    /function isLinkable/.test(CH) && /c\.kind !== 'removed'/.test(CH))
  // Severity order is the driving order. Asserted by running it, not by reading it.
  const before = snap(day([stop({ id: 'a' }), stop({ id: 'b' }), stop({ id: 'c' })], { day_note: 'x' }))
  const after = snap(day([
    stop({ id: 'b', notes: 'new note' }), stop({ id: 'c', status: 'cancelled' }), stop({ id: 'd' }),
  ], { day_note: 'y' }))
  const cs = diffCrewDay(before, after)
  const order = kinds(cs)
  const idx = (k: CrewChangeKind) => order.indexOf(k)
  check('removed and cancelled sort above instructions and notes',
    idx('removed') < idx('instruction') && idx('cancelled') < idx('day_note'),
    JSON.stringify(order))
  check('a five-change morning still leads with the wasted trip',
    order[0] === 'removed', JSON.stringify(order))
}

console.log('\n── 10. The field home surface ─────────────────────────────────')
// The landing, the header, the two exits from the clock, and the offline shell.
// Each is asserted at the place a refactor would break it.
{
  // WHERE A WORKER LANDS. The redirect table is pure — run it, don't read it.
  // A crew sign-in must arrive at Today, and no path through the table may put
  // a crew session on the owner's CRM.
  check('a crew sign-in lands on Today', routeFor('crew', '/login', true) === '/crew')
  check('a crew session on the owner dashboard is sent home',
    routeFor('crew', '/dashboard', true) === '/crew')
  check('…including deep owner paths', routeFor('crew', '/dashboard/customers', true) === '/crew')
  check('a crew session already home is left alone', routeFor('crew', '/crew', true) === null)
  check('an owner is never routed into Crew Mode', routeFor('owner', '/crew', true) === '/dashboard')
  check('a linked-to-nothing account is sent to join, not shown a day',
    routeFor('none', '/crew', true) === '/crew/join')
  check('signed out, the day is behind the login', routeFor('none', '/crew', false) === '/login')
}
{
  const TODAY = read('src/components/crew/CrewToday.tsx')
  // THE HEADER ANSWERS AT A GLANCE: what kind of morning, and where first.
  check('the header states day progress in all three shapes',
    /Nothing booked today/.test(TODAY) && /of \$\{active\.length\} to go/.test(TODAY) &&
    /All \$\{active\.length\} done/.test(TODAY))
  check('the header names the first/next stop before any scrolling',
    /First up/.test(TODAY) && /'Now'/.test(TODAY) &&
    /next\.customer\?\.name \|\| next\.title/.test(TODAY))
  // TWO EXITS FROM THE CLOCK, two writers. "Done for today" banks the time and
  // leaves the visit open; "Finish" hands off to billing. Conflating them is
  // the multi-day bug the work-sessions vocabulary exists to prevent.
  //
  // ⚠️ RE-EXPRESSED, NOT WEAKENED (Field Reliability V1). Both writers used to be
  // called from this component, so grepping it proved they were distinct. The
  // offline layer moved the CALL behind one dispatcher — CrewToday now builds a
  // typed intent and lib/field/fieldWrite routes it — so the old grep went red
  // because the seam moved, not because the two exits merged.
  //
  // ⭐ The rule is now asserted where it actually lives, and more strictly than
  // before: the intent KINDS must stay distinct, and the dispatcher must map
  // each to its OWN writer. A future edit that pointed 'stop_for_day' at
  // crewCompleteVisit — the actual multi-day bug — would now fail here, whereas
  // the old grep would happily have passed on two unrelated mentions.
  const FW = read('src/lib/field/fieldWrite.ts')
  check('“Done for today” is still its own intent, not a flavour of finishing',
    /'stop_for_day'/.test(FW) && /'complete'/.test(FW) && /Done for today/.test(TODAY))
  check('stopping for the day and finishing are different writers',
    /crewStopForToday\(/.test(FW) && /crewCompleteVisit\(/.test(FW))
  check('…and the dispatcher maps each intent to its OWN writer',
    /kind === 'stop_for_day' \? await crewStopForToday\(/.test(FW) &&
    /kind === 'complete' \? await crewCompleteVisit\(/.test(FW))
  check('the component still routes both through the one honest reporter',
    /runVisitIntent\(/.test(TODAY) && /buildVisitIntent\(/.test(TODAY))
}
{
  // THE OFFLINE SHELL. sw.js caches field-route HTML by explicit allowlist.
  // '/crew' is a client page under a data-free gate layout, so it qualifies;
  // '/crew/schedule' is an async SERVER component that bakes day counts into
  // its HTML, so caching it would replay a stale week as live — it must stay
  // OFF the list. The !res.redirected guard is what keeps a signed-out bounce
  // from being pinned as the crew's shell forever.
  const SW = read('public/sw.js')
  const shells = SW.match(/const FIELD_SHELLS = \[([^\]]*)\]/)?.[1] ?? ''
  check("the worker's day is on the offline-shell allowlist", /'\/crew'/.test(shells), shells)
  check('the server-rendered crew week is NOT cached', !/crew\/schedule/.test(shells), shells)
  check('a redirected response is never cached as a shell', /!res\.redirected/.test(SW))
}
{
  // ⭐⭐ THREE THINGS S65 MADE SEPARABLE, and the surface must not merge them:
  //   crew MEMBERSHIP        → day.teammates (who shares the crew)
  //   planned ASSIGNMENT     → crew_assignment_covers: the crew's, or a person's
  //   actual PARTICIPATION   → not claimed here at all
  // The failure this pins: a worker on Crew A whose whole day is assigned to
  // them individually being told they are "with Sarah, Mike" — a roster fact
  // rendered as a fact about today's work.
  const TODAY = read('src/components/crew/CrewToday.tsx')
  check('the direct-vs-crew distinction comes from the SERVER, never inferred',
    /s\.personal === true/.test(TODAY) && !/technician_id/.test(TODAY),
    'the phone must read crew_day\'s `personal`, never re-derive assignment')
  check('an all-direct day does not name teammates as today\'s company',
    /!allPersonal/.test(TODAY) && /allPersonal && <span>· today’s stops are assigned to you/.test(TODAY),
    'membership is not participation — the teammate list is a claim about the crew, not the day')
  check('an empty day makes no assignment claim at all',
    /active\.length > 0 && active\.every\(s => s\.personal === true\)/.test(TODAY),
    'with no stops there is nothing to say about who they belong to')
}
{
  // S69's checklist summary and S67's availability reach this screen through
  // crew_day and lib/dayFit respectively. This surface must carry them, not
  // re-implement or drop them.
  const TODAY = read('src/components/crew/CrewToday.tsx')
  check('the S69 checklist summary still reaches the card',
    /CrewStopChecklist/.test(TODAY) && /gateBlocked/.test(TODAY),
    'the completion gate\'s required-item list must survive this lane')
}
{
  // NO MONEY ON A WORKER'S PHONE. crew_day already selects none (section 8);
  // this pins the render side of the same claim over the two components this
  // session owns, comments stripped first so the rule cannot be satisfied or
  // tripped by its own documentation.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/([^:'"])\/\/[^\n]*/g, '$1')
  const src = strip(read('src/components/crew/CrewToday.tsx')) + strip(read('src/components/crew/CrewChanges.tsx'))
  check('no money identifier reaches the field home render',
    !/\b(price|margin|profit|revenue|balance|wage|invoice_total)\b/i.test(src))
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:field-home — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:field-home — the field home says what is true, and nothing else\n')
