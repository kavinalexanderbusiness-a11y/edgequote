// ── Verify: service location intelligence stays honest ───────────────────────
//   npm run verify:location-intelligence
//
// WHY THIS SCRIPT EXISTS
// A property summary fails in ways that are not type errors and never throw. Every
// one of them renders as a confident sentence:
//
//   * a visit read that FAILED rendering as "No completed visits yet" — a claim
//     about the property made by a request that learned nothing about it
//   * a typical duration inferred from ONE visit, or presented with a sample size
//     larger than the visits actually behind it (the Properties list did exactly
//     this: a mean labelled "avg of {all completed visits}" when only a fraction
//     were timed)
//   * a mis-tapped stopwatch (production holds a real 1-minute visit) dragging an
//     address's typical time toward nothing
//   * "Lawn Mowing" and "Lawn mowing" counted as two services — or worse, two
//     genuinely different services merged because their labels looked alike
//   * a cancelled visit counted as history, or a past booking shown as "next"
//   * PRIVATE access notes (gate codes, dog, alarm) reaching the customer portal
//   * one tenant's property summary built from another tenant's rows
//
// Runs the REAL modules against hand-derived fixtures, plus source assertions for
// the invariants a fixture cannot reach. Deterministic, no network.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildLocationSummary, typicalDurationFrom, describeTypicalDuration,
  MIN_TYPICAL_SAMPLE, type LocationVisit, type SourceRead,
} from '../src/lib/locationSummary'
import { MIN_PLAUSIBLE_MINUTES, MAX_PLAUSIBLE_MINUTES } from '../src/lib/estimateVsActual'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const root = join(__dirname, '..')
// ⚠️ CRLF: this repo checks out with \r\n, and JS `.` does not match \r — so a
// `//.*$` stripper silently strips NOTHING and every "absence" assertion below
// would invert into a false pass. Normalise at the door, before any regex.
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')

const TODAY = '2026-08-11'
const visit = (o: Partial<LocationVisit> & { id: string }): LocationVisit =>
  ({ status: 'completed', service_type: 'Lawn Mowing', title: 'Weekly mow', scheduled_date: '2026-08-01', ...o })
const rows = (vs: LocationVisit[]): SourceRead<LocationVisit> => ({ ok: true, rows: vs })
const build = (vs: LocationVisit[], photoCount: number | null = 0) =>
  buildLocationSummary({ visits: rows(vs), photoCount, todayISO: TODAY })

// ── 1. UNKNOWN IS NOT EMPTY ──────────────────────────────────────────────────
// The whole reason the engine takes a discriminated SourceRead. These two inputs
// must not produce the same summary, because they are not the same fact.
console.log('\nA failed read and an empty one are different answers:')
{
  const broke = buildLocationSummary({ visits: { ok: false }, photoCount: null, todayISO: TODAY })
  const empty = build([])

  check('a FAILED visit read is flagged unknown', broke.visitsUnknown, 'visitsUnknown was false')
  eq('…and its completed count is null, NOT zero', broke.completedCount, null)
  eq('…and its timed-visit count is null, NOT zero', broke.timedVisits, null)
  eq('…and it claims no last visit', broke.lastVisit, null)
  eq('…and no typical duration', broke.typicalDuration, null)
  eq('…and a failed photo count is null, NOT zero', broke.photoCount, null)

  check('an EMPTY visit read is NOT flagged unknown', !empty.visitsUnknown, 'visitsUnknown was true')
  eq('…and its completed count is a real zero', empty.completedCount, 0)
  eq('…and its timed-visit count is a real zero', empty.timedVisits, 0)

  check('so a surface can tell the two apart',
        broke.completedCount !== empty.completedCount,
        'both reported the same completedCount — "couldn\'t load" is rendering as "none"')
}

// ── 2. TYPICAL DURATION — the sample size is the honesty ─────────────────────
console.log('\nA typical visit time is withheld until it means something:')
{
  const timed = (n: number, mins: number[]) =>
    mins.slice(0, n).map((m, i) => visit({ id: `t${i}`, actual_minutes: m }))

  eq('one visit is never a typical value', build(timed(1, [45])).typicalDuration, null)
  eq(`…nor is ${MIN_TYPICAL_SAMPLE - 1}`, build(timed(2, [45, 47])).typicalDuration, null)

  const at = build(timed(3, [40, 45, 50])).typicalDuration
  check(`…but ${MIN_TYPICAL_SAMPLE} is`, at != null, 'got null at the threshold')
  eq('…reported as the median', at!.minutes, 45)
  eq('…carrying the number of visits behind it', at!.sampleSize, 3)

  // The specific protection a median buys: one enormous day cannot move the
  // centre, where a mean would report a time no visit here has ever taken.
  const skew = build([
    visit({ id: 'a', actual_minutes: 40 }), visit({ id: 'b', actual_minutes: 45 }),
    visit({ id: 'c', actual_minutes: 50 }), visit({ id: 'd', actual_minutes: 900 }),
  ]).typicalDuration!
  check('one 15-hour day does not become everyone\'s typical visit',
        skew.minutes <= 60, `median was ${skew.minutes} — a mean would have said 259`)

  // The sample size must count TIMED visits, not completed ones. This is the
  // exact overstatement the Properties list shipped with.
  const mixed = build([
    visit({ id: 'a', actual_minutes: 40 }), visit({ id: 'b', actual_minutes: 45 }),
    visit({ id: 'c', actual_minutes: 50 }),
    visit({ id: 'd', actual_minutes: null }), visit({ id: 'e', actual_minutes: null }),
  ])
  eq('the sample counts TIMED visits…', mixed.typicalDuration!.sampleSize, 3)
  eq('…not the property\'s completed visits', mixed.completedCount, 5)
  check('…so the two are not interchangeable',
        mixed.typicalDuration!.sampleSize !== mixed.completedCount, 'they matched by accident — widen the fixture')

  // An untimed visit is unknown, never a zero-minute visit.
  eq('untimed visits do not enter as zeros', build([
    visit({ id: 'a', actual_minutes: 40 }), visit({ id: 'b', actual_minutes: 44 }),
    visit({ id: 'c', actual_minutes: 48 }), visit({ id: 'd', actual_minutes: 0 }),
  ]).typicalDuration!.sampleSize, 3)
}

// ── 3. IMPLAUSIBLE TIMINGS ───────────────────────────────────────────────────
// Bounds are IMPORTED from lib/estimateVsActual, not restated — this proves the
// engine actually applies them rather than declaring them.
console.log('\nA mis-tap or a timer left running is not evidence:')
{
  const under = build([
    visit({ id: 'a', actual_minutes: 1 }), visit({ id: 'b', actual_minutes: 45 }),
    visit({ id: 'c', actual_minutes: 47 }), visit({ id: 'd', actual_minutes: 43 }),
  ])
  eq(`a ${MIN_PLAUSIBLE_MINUTES > 1 ? '1-minute' : 'sub-bound'} visit is discarded`, under.typicalDuration!.sampleSize, 3)
  check('…so it cannot drag the median down', under.typicalDuration!.minutes >= 43,
        `median ${under.typicalDuration!.minutes}`)

  const over = build([
    visit({ id: 'a', actual_minutes: MAX_PLAUSIBLE_MINUTES + 1 }), visit({ id: 'b', actual_minutes: 45 }),
    visit({ id: 'c', actual_minutes: 47 }), visit({ id: 'd', actual_minutes: 43 }),
  ])
  eq('an overnight timer is discarded', over.typicalDuration!.sampleSize, 3)

  // Mutation test: if the bound were removed, the fixture above MUST change its
  // answer — otherwise this section proves nothing.
  check('…and the bound is load-bearing (removing it would change the answer)',
        typicalDurationFrom([
          visit({ id: 'a', actual_minutes: MAX_PLAUSIBLE_MINUTES + 1 }), visit({ id: 'b', actual_minutes: 45 }),
          visit({ id: 'c', actual_minutes: 47 }), visit({ id: 'd', actual_minutes: 43 }),
        ])!.sampleSize !== 4,
        'the implausible row survived — the bound is not applied')
}

// ── 4. ONE ENGINE ────────────────────────────────────────────────────────────
console.log('\nThe list and the summary answer with the same engine:')
{
  const vs = [
    visit({ id: 'a', actual_minutes: 40 }), visit({ id: 'b', actual_minutes: 45 }),
    visit({ id: 'c', actual_minutes: 50 }), visit({ id: 'd', actual_minutes: 1 }),
  ]
  const viaSummary = build(vs).typicalDuration!
  const viaList = typicalDurationFrom(vs)!
  eq('same median', viaList.minutes, viaSummary.minutes)
  eq('same sample size', viaList.sampleSize, viaSummary.sampleSize)

  const list = read('src/app/dashboard/properties/page.tsx')
  check('the Properties list imports the engine',
        /from '@\/lib\/locationSummary'/.test(list), 'no import found')
  check('…and no longer keeps its own duration mean',
        !/durSum|avgActualMin/.test(list),
        'a hand-rolled average survives in the list page')
  check('…and never labels a learned time with the total completed-visit count',
        !/avg of \{perf/.test(list),
        'the overstated sample-size label is still rendered')
}

// ── 5. THE SAMPLE SIZE CANNOT BE DROPPED BY A CALL SITE ──────────────────────
console.log('\nThe number cannot be shown without its evidence:')
{
  const d = describeTypicalDuration({ minutes: 42, sampleSize: 8 })
  check('the shared wording states the sample', /8 timed visits/.test(d), d)
  check('…and hedges the figure', /about/.test(d), d)
  eq('…singular reads correctly', describeTypicalDuration({ minutes: 42, sampleSize: 1 }), 'about 42 min · 1 timed visit')

  const card = read('src/components/properties/LocationSummaryCard.tsx')
  check('the field card renders the duration ONLY through that wording',
        !/typicalDuration\.minutes/.test(card),
        'the card reaches for .minutes directly — the sample size can be dropped')
}

// ── 6. SERVICE IDENTITY IS DECLARED, NEVER GUESSED ───────────────────────────
console.log('\nServices group by the canonical table, not by lookalike text:')
{
  const s = build([
    visit({ id: 'a', service_type: 'Lawn Mowing' }),
    visit({ id: 'b', service_type: 'Lawn mowing' }),
    visit({ id: 'c', service_type: 'Weekly Mowing' }),
    visit({ id: 'd', service_type: 'Mulch Installation' }),
  ]).services

  const mowing = s.find(x => x.key === 'mowing')
  eq('four spellings of one service collapse to one bucket', mowing?.completed, 3)
  check('…and mulch stays its own service', s.some(x => x.key === 'mulch'), JSON.stringify(s))
  eq('…so the property lists exactly two services', s.length, 2)
  check('…most-performed first', s[0].key === 'mowing', JSON.stringify(s))

  // Unknown/ad-hoc work still accrues history rather than vanishing.
  const adhoc = build([visit({ id: 'z', service_type: 'Xanthe mow + prune ' })]).services
  eq('an ad-hoc label still lands in a bucket', adhoc.length, 1)

  // Only COMPLETED work is "performed".
  const notYet = build([visit({ id: 'q', status: 'scheduled', scheduled_date: '2026-09-01' })]).services
  eq('a booked-but-undone visit is not a service performed', notYet.length, 0)
}

// ── 7. WHICH VISIT IS "LAST" AND WHICH IS "NEXT" ─────────────────────────────
console.log('\nLast means done; next means still ahead:')
{
  const s = build([
    visit({ id: 'old', completed_at: '2026-07-01T15:00:00Z', scheduled_date: '2026-07-01' }),
    visit({ id: 'new', completed_at: '2026-08-08T15:00:00Z', scheduled_date: '2026-08-08' }),
    visit({ id: 'soon', status: 'scheduled', scheduled_date: '2026-08-15', title: 'Lawn service' }),
    visit({ id: 'later', status: 'scheduled', scheduled_date: '2026-09-20' }),
    visit({ id: 'past', status: 'scheduled', scheduled_date: '2026-06-01' }),
    visit({ id: 'gone', status: 'cancelled', scheduled_date: '2026-08-12' }),
  ])
  eq('the most recent COMPLETED visit is last', s.lastVisit?.id, 'new')
  eq('the soonest FUTURE booking is next', s.nextVisit?.id, 'soon')
  eq('…named by its own title', s.nextVisit?.title, 'Lawn service')
  eq('a cancelled visit is never "next"', s.nextVisit?.id !== 'gone', true)
  eq('…nor counted as history', s.completedCount, 2)
  check('a past booking that never completed is not "next"',
        s.nextVisit?.id !== 'past', 'a stale booking is being shown as upcoming')

  // Today's visit is still ahead of you — the owner's local date, not UTC.
  eq('a visit booked for TODAY is still upcoming',
     build([visit({ id: 'now', status: 'scheduled', scheduled_date: TODAY })]).nextVisit?.id, 'now')

  // in_progress is happening right now, and is still the thing you're here for.
  eq('a visit in progress is the next thing',
     build([visit({ id: 'run', status: 'in_progress', scheduled_date: TODAY })]).nextVisit?.id, 'run')

  // completed_at is canonical, but 7 of 72 rows predate that stamp.
  eq('a completion with no stamp still dates from its scheduled day',
     build([visit({ id: 'u', completed_at: null, scheduled_date: '2026-05-05' })]).lastVisit?.date, '2026-05-05')
}

// ── 8. ONE ROW PER VISIT ─────────────────────────────────────────────────────
console.log('\nA visit cannot vote twice:')
{
  const dup = visit({ id: 'same', actual_minutes: 45 })
  const s = build([dup, { ...dup }, { ...dup }, visit({ id: 'b', actual_minutes: 41 }), visit({ id: 'c', actual_minutes: 43 })])
  eq('a duplicated row is counted once', s.completedCount, 3)
  eq('…so it cannot inflate the sample size', s.timedVisits, 3)
}

// ── 9. THE ENGINE IS PURE ────────────────────────────────────────────────────
console.log('\nThe engine cannot reach the database or the DOM:')
{
  const src = read('src/lib/locationSummary.ts')
  const imports = src.split('\n').filter(l => /^\s*import\s/.test(l))
  check('it imports something (the scan is live)', imports.length > 0, 'no import lines found')
  check('…and nothing that can reach the database',
        !imports.some(l => /supabase|createClient|node:|fetch/i.test(l)), imports.join(' | '))
  check('…and nothing from React', !imports.some(l => /\breact\b/i.test(l)), imports.join(' | '))
  check('…and no clock of its own (todayISO is passed in)',
        !/Date\.now\(\)|new Date\(\)/.test(src), 'the engine reads a clock directly')
  check('…only the canonical service normalizer and the shared plausibility bounds',
        imports.every(l => /serviceKey|estimateVsActual/.test(l)), imports.join(' | '))
}

// ── 10. THE LOADER BRANCHES ON error, NOT ON EMPTINESS ───────────────────────
// A failed PostgREST read also carries `data: null`, so a loader that tests the
// data alone routes every failure into the empty case — which would make section
// 1 unreachable in the real app no matter how correct the engine is.
console.log('\nThe loader can actually produce an unknown:')
{
  const src = read('src/lib/locationSummaryData.ts')
  check('it inspects the visit read\'s error', /visitRes\.error/.test(src), 'no error check found')
  check('…and returns ok:false on it', /\{\s*ok:\s*false\s*\}/.test(src), 'no failure branch found')
  check('the photo count is null on failure, not 0',
        /photoRes\.error\s*\?\s*null/.test(src), 'a failed count would read as zero photos')
  check('…and it never swallows a read with `|| []` as the failure path',
        !/(visitRes|photoRes)\.error[^\n]*\|\|\s*\[\]/.test(src), 'a failure degrades to empty')
}

// ── 11. TENANT ISOLATION ─────────────────────────────────────────────────────
console.log('\nOne business cannot summarise another\'s property:')
{
  const src = read('src/lib/locationSummaryData.ts')
  const eqUser = (src.match(/\.eq\('user_id', userId\)/g) || []).length
  check('every read is scoped to the signed-in owner', eqUser >= 2,
        `found ${eqUser} user_id filters for 2 reads`)
  check('…and to the requested property', (src.match(/\.eq\('property_id', propertyId\)/g) || []).length >= 2,
        'a read is not scoped to the property')
  check('the loader never uses a service-role client',
        !/service_role|SERVICE_ROLE/.test(src), 'a service-role key appears in the loader')

  const engine = read('src/lib/locationSummary.ts')
  check('the engine states that scoping is the caller\'s job',
        /TENANCY/.test(engine), 'the tenancy contract is undocumented')
}

// ── 12. PRIVATE NOTES STAY PRIVATE ───────────────────────────────────────────
// The structural guarantee: get_portal_data enumerates the property columns it
// returns, so a new column is invisible to the portal unless someone adds it.
// This asserts nobody has.
console.log('\nAccess notes never reach the customer portal:')
{
  const sql = read('supabase/CANONICAL-get_portal_data.sql')
  check('the canonical portal RPC does not return internal_notes',
        !/internal_notes/.test(sql), 'internal_notes is being sent to the portal')

  // The guarantee only holds while the projection is an explicit column list —
  // a `select *` or a to_jsonb(row) would sweep the new column in silently.
  const propSelects = sql.split('\n').filter(l => /from public\.properties/.test(l))
  check('…and the property projections are still explicit column lists',
        propSelects.length > 0 && propSelects.every(l => !/select\s+\*|to_jsonb/i.test(l)),
        propSelects.join(' | ') || 'no property projection found')

  // And nothing in the portal renders it even if it somehow arrived.
  const portalDir = 'src/app/portal'
  const hits = listFiles(join(root, portalDir)).filter(f => /internal_notes/.test(readFileSync(f, 'utf8')))
  check('no portal component reads internal_notes', hits.length === 0, hits.join(', '))

  // The owner-side surface must distinguish the two note fields at rest, or the
  // gate code goes in the customer-facing one.
  const card = read('src/components/properties/LocationSummaryCard.tsx')
  check('the private field is labelled private where it is READ, not only edited',
        /private/i.test(card.split('editing ?')[0]), 'the privacy label only appears in edit mode')
  const detail = read('src/app/dashboard/properties/[id]/page.tsx')
  check('…and the customer-facing field says so in its own heading',
        /shared with the customer/i.test(detail), 'the public notes card does not state its audience')
}

// ── 13. THE SURFACE RENDERS UNKNOWN AS UNKNOWN ───────────────────────────────
console.log('\nThe field card says "couldn\'t load", never "none":')
{
  const card = read('src/components/properties/LocationSummaryCard.tsx')
  check('it branches on visitsUnknown', /visitsUnknown/.test(card), 'the unknown state is never checked')
  check('…before the empty copy is reachable',
        card.indexOf('visitsUnknown') < card.indexOf('No completed visits yet'),
        'the empty state is rendered ahead of the failure state')
  check('…and offers a retry', /onRetry/.test(card), 'no retry affordance')
  check('the property page feeds a thrown read into that state',
        /visitsUnknown:\s*true/.test(read('src/app/dashboard/properties/[id]/page.tsx')),
        'a thrown loadLocationSummary would render as empty')
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...listFiles(p))
    else if (/\.(tsx?|sql)$/.test(e)) out.push(p)
  }
  return out
}

console.log('')
if (failures) { console.log(`✗ ${failures} location-intelligence check(s) failed\n`); process.exit(1) }
console.log('✓ all location-intelligence checks passed — unknown stays unknown, samples travel with their numbers, and access notes stay private\n')
