/* eslint-disable no-console */
// ── Optimizer benchmark + invariant harness ───────────────────────────────────
// Deterministic synthetic schedules → run optimizeSchedule across scopes/modes →
// assert HARD invariants (locks, windows, preferences, cadence on the final
// timeline, determinism) and report quality/perf so engine changes can be
// compared apples-to-apples. Run via:
//   npx esbuild scripts/bench-optimizer.ts --bundle --platform=node \
//     --alias:@=./src --outfile=scripts/.bench.cjs && node scripts/.bench.cjs

import { addDays, format, getDay, parseISO } from 'date-fns'
import { optimizeSchedule, analyzeSchedule, metricsWithMoves, cadenceFloorFor, cadenceGroupKey, cadenceServiceKey, manualCadenceCheck, scopeWindows } from '@/lib/optimizer'
import type { OptJob, OptOptions, OptimizationResult, OptimizeMode, OptimizeScope } from '@/lib/optimizer'
import { effectiveFreq } from '@/lib/invoicing'
import { haversineKm } from '@/lib/geo'

// Seeded LCG so every run generates the identical schedule.
function lcg(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const TODAY = '2026-06-12' // Friday
const BASE = { lat: 51.0, lng: -114.1 }
const PREF_DAYS = [5, 6, 0] // Fri/Sat/Sun
const CAP_HOURS = 8

type Rec = { freq: string | null; interval_unit: string | null; interval_count: number | null }

interface Gen { jobs: OptJob[]; recs: Record<string, Rec> }

const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const addISO = (dateISO: string, days: number) => iso(addDays(parseISO(dateISO + 'T00:00:00'), days))

// Next date ≥ from with the given weekday.
function nextDow(fromISO: string, dow: number): string {
  let d = parseISO(fromISO + 'T00:00:00')
  for (let i = 0; i < 7; i++) { if (getDay(d) === dow) return iso(d); d = addDays(d, 1) }
  return fromISO
}

function genSchedule(seed: number): Gen {
  const rnd = lcg(seed)
  const jobs: OptJob[] = []
  const recs: Record<string, Rec> = {}
  const hoods = Array.from({ length: 8 }, (_, i) => ({
    name: `Hood${i}`,
    lat: BASE.lat + Math.cos((i / 8) * 2 * Math.PI) * 0.05,
    lng: BASE.lng + Math.sin((i / 8) * 2 * Math.PI) * 0.07,
  }))
  const pt = (h: typeof hoods[number]) => ({ lat: h.lat + (rnd() - 0.5) * 0.008, lng: h.lng + (rnd() - 0.5) * 0.008 })
  let jid = 0
  // All recurring series are mowing; one-times override with a mix so cross-
  // category (mow vs fertilization/cleanup/snow) and same-category cases both exist.
  const push = (j: Omit<OptJob, 'id' | 'title'>) => { jid++; jobs.push({ serviceType: 'Lawn Mowing', ...j, id: `j${jid}`, title: `Job ${jid}` }) }
  const ONE_OFF_SVC = ['Lawn Mowing', 'Fertilization', 'Yard Cleanup', 'Snow Removal']

  // 18 weekly series: 4 past + 10 future visits, mostly on an established weekday.
  for (let i = 0; i < 18; i++) {
    const h = hoods[i % 8]
    const est = PREF_DAYS[i % 3]
    const rid = `rec-w${i}`
    recs[rid] = { freq: 'weekly', interval_unit: 'week', interval_count: 1 }
    const p = pt(h)
    const anchor = nextDow(addISO(TODAY, -28), est)
    for (let v = 0; v < 14; v++) {
      let date = addISO(anchor, v * 7)
      // ~20% of future visits deliberately misplaced +1 day (sub-optimal placement).
      if (date > TODAY && rnd() < 0.2) date = addISO(date, 1)
      push({
        scheduled_date: date, status: date <= TODAY ? 'completed' : 'scheduled',
        recurrence_id: rid, start_time: null, duration_minutes: 40 + Math.floor(rnd() * 25),
        lat: p.lat, lng: p.lng, value: 55, invoiced: false,
        customerName: `Weekly ${i}`, customerId: `cust-w${i}`, neighborhood: h.name,
        // a few customers have real preferences
        avoidDays: i % 6 === 0 ? [0] : null, preferredDays: i % 7 === 0 ? [est] : null,
      })
    }
  }
  // 8 biweekly series.
  for (let i = 0; i < 8; i++) {
    const h = hoods[(i + 3) % 8]
    const est = PREF_DAYS[(i + 1) % 3]
    const rid = `rec-b${i}`
    recs[rid] = { freq: 'biweekly', interval_unit: 'week', interval_count: 2 }
    const p = pt(h)
    const anchor = nextDow(addISO(TODAY, -28), est)
    for (let v = 0; v < 7; v++) {
      const date = addISO(anchor, v * 14)
      push({
        scheduled_date: date, status: date <= TODAY ? 'completed' : 'scheduled',
        recurrence_id: rid, start_time: null, duration_minutes: 50 + Math.floor(rnd() * 25),
        lat: p.lat, lng: p.lng, value: 70, invoiced: false,
        customerName: `Biweekly ${i}`, customerId: `cust-b${i}`, neighborhood: h.name,
        avoidDays: null, preferredDays: null,
      })
    }
  }
  // 2 every-10-days + 2 every-3-weeks custom-cadence series.
  for (let i = 0; i < 2; i++) {
    const rid = `rec-d10-${i}`
    recs[rid] = { freq: null, interval_unit: 'day', interval_count: 10 }
    const h = hoods[(i + 5) % 8]; const p = pt(h)
    for (let v = 0; v < 6; v++) {
      const date = addISO(TODAY, 3 + i + v * 10)
      push({
        scheduled_date: date, status: 'scheduled', recurrence_id: rid, start_time: null,
        duration_minutes: 60, lat: p.lat, lng: p.lng, value: 80, invoiced: false,
        customerName: `Ten-day ${i}`, customerId: `cust-d${i}`, neighborhood: h.name, avoidDays: null, preferredDays: null,
      })
    }
  }
  for (let i = 0; i < 2; i++) {
    const rid = `rec-w3-${i}`
    recs[rid] = { freq: null, interval_unit: 'week', interval_count: 3 }
    const h = hoods[(i + 1) % 8]; const p = pt(h)
    const anchor = nextDow(addISO(TODAY, 2 + i), PREF_DAYS[i])
    for (let v = 0; v < 4; v++) {
      push({
        scheduled_date: addISO(anchor, v * 21), status: 'scheduled', recurrence_id: rid, start_time: null,
        duration_minutes: 55, lat: p.lat, lng: p.lng, value: 90, invoiced: false,
        customerName: `Triweek ${i}`, customerId: `cust-t${i}`, neighborhood: h.name, avoidDays: null, preferredDays: null,
      })
    }
  }
  // 40 one-time jobs over the next 6 weeks (some on non-preferred days).
  for (let i = 0; i < 40; i++) {
    const h = hoods[Math.floor(rnd() * 8)]
    const p = pt(h)
    const off = 1 + Math.floor(rnd() * 42)
    push({
      scheduled_date: addISO(TODAY, off), status: 'scheduled', recurrence_id: null, start_time: null,
      duration_minutes: 35 + Math.floor(rnd() * 50), lat: p.lat, lng: p.lng,
      value: 60 + Math.floor(rnd() * 60), invoiced: false,
      customerName: `OneTime ${i}`, customerId: `cust-o${i}`, neighborhood: h.name,
      serviceType: ONE_OFF_SVC[i % 4],
      avoidDays: i % 9 === 0 ? [6] : null, preferredDays: null,
    })
  }
  // Pack next Friday (overload scenario): 9 extra jobs in one hood.
  const packed = addISO(TODAY, 7) // 2026-06-19, a Friday
  for (let i = 0; i < 9; i++) {
    const p = pt(hoods[2])
    push({
      scheduled_date: packed, status: 'scheduled', recurrence_id: null, start_time: null,
      duration_minutes: 55, lat: p.lat, lng: p.lng, value: 75, invoiced: false,
      customerName: `Packed ${i}`, customerId: `cust-p${i}`, neighborhood: 'Hood2', avoidDays: null, preferredDays: null,
    })
  }
  // Locks: every 11th future job gets a start time; every 17th is invoiced.
  let n = 0
  for (const j of jobs) {
    if (j.scheduled_date <= TODAY || j.status !== 'scheduled') continue
    n++
    if (n % 11 === 0) j.start_time = '09:00'
    if (n % 17 === 0) j.invoiced = true
  }
  return { jobs, recs }
}

// ── Invariant validation ──────────────────────────────────────────────────────
function moveWindow(j: OptJob, recs: Record<string, Rec>): number {
  if (!j.recurrence_id) return 6
  const r = recs[j.recurrence_id]
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4
}
const dayDiff = (a: string, b: string) => Math.round((parseISO(b + 'T00:00:00').getTime() - parseISO(a + 'T00:00:00').getTime()) / 86400000)

function validate(name: string, gen: Gen, opts: OptOptions, res: OptimizationResult): string[] {
  const errs: string[] = []
  const byId = new Map(gen.jobs.map(j => [j.id, j]))
  const win = scopeWindows(opts.scope, opts.anchorDate, opts.today)
  const finalDate = new Map(gen.jobs.map(j => [j.id, j.scheduled_date]))
  for (const m of res.moves) finalDate.set(m.jobId, m.to)
  const prefSet = new Set(opts.preferredDays)

  for (const m of res.moves) {
    const j = byId.get(m.jobId)
    if (!j) { errs.push(`${name}: move for unknown job ${m.jobId}`); continue }
    if (j.invoiced) errs.push(`${name}: moved invoiced job ${j.id}`)
    if (j.start_time) errs.push(`${name}: moved time-locked job ${j.id}`)
    if (j.status !== 'scheduled') errs.push(`${name}: moved ${j.status} job ${j.id}`)
    if (j.scheduled_date <= opts.today) errs.push(`${name}: moved past/today job ${j.id}`)
    if (m.from !== j.scheduled_date) errs.push(`${name}: move.from mismatch for ${j.id}`)
    if (m.to <= opts.today) errs.push(`${name}: target not in future for ${j.id}`)
    if (m.to === m.from) errs.push(`${name}: NO-OP move (from===to) for ${j.id}`)
    if (!(j.scheduled_date >= win.movableStart && (win.movableEnd == null || j.scheduled_date <= win.movableEnd)))
      errs.push(`${name}: origin outside movable window for ${j.id}`)
    if (!(m.to >= win.targetStart && (win.targetEnd == null || m.to <= win.targetEnd)))
      errs.push(`${name}: target outside target window for ${j.id}`)
    const dow = getDay(parseISO(m.to + 'T00:00:00'))
    if (prefSet.size && !prefSet.has(dow)) errs.push(`${name}: target on non-work day for ${j.id}`)
    if (j.avoidDays?.includes(dow)) errs.push(`${name}: target on customer avoid-day for ${j.id}`)
    if (Math.abs(dayDiff(m.from, m.to)) > moveWindow(j, opts.recurrences))
      errs.push(`${name}: move exceeds cadence window for ${j.id} (${m.from}→${m.to})`)
  }

  // Final-timeline cadence for every MOVED job: no same-day mate, gaps ≥ floor.
  const groups = new Map<string, OptJob[]>()
  for (const j of gen.jobs) {
    if (j.status === 'cancelled') continue
    const k = cadenceGroupKey(j)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(j)
  }
  for (const m of res.moves) {
    const j = byId.get(m.jobId)!
    const mates = (groups.get(cadenceGroupKey(j)) || []).filter(x => x.id !== j.id)
    if (!mates.length) continue
    const floor = cadenceFloorFor(j.recurrence_id, opts.recurrences)
    for (const mate of mates) {
      const gap = Math.abs(dayDiff(finalDate.get(mate.id)!, m.to))
      if (gap === 0) errs.push(`${name}: COLLISION — ${j.customerName} double-booked on ${m.to}`)
      else if (gap < floor) errs.push(`${name}: cadence floor broken for ${j.customerName} (gap ${gap} < ${floor})`)
    }
  }
  return errs
}

// ── Same-category cadence rule (the user's spec, asserted directly) ───────────
function testCadenceRule(): number {
  let fails = 0
  const recs = {}
  const FRI = '2026-06-19'
  type V = { id: string; scheduled_date: string; status: string; customerId: string | null; recurrence_id: string | null; serviceType: string; customerName: string }
  const visit = (id: string, date: string, svc: string, cust: string | null = 'C', rid: string | null = null): V =>
    ({ id, scheduled_date: date, status: 'scheduled', customerId: cust, recurrence_id: rid, serviceType: svc, customerName: 'Test' })
  const expect = (name: string, ok: boolean) => { if (!ok) { fails++; console.error('✗ cadence-rule: ' + name) } }
  const chk = (move: { id: string; customerId: string | null; recurrence_id: string | null; serviceType: string }, to: string, mates: V[]) =>
    manualCadenceCheck(move, to, mates, recs).status

  // Allowed: two mows ≥4 days apart.
  expect('mow Fri→Tue (4d) allowed', chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: 'Weekly Mowing' }, addISO(FRI, 4), [visit('m', FRI, 'Lawn Mowing')]) === 'ok')
  expect('mow Fri→Wed (5d) allowed', chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: 'Lawn Mowing' }, addISO(FRI, 5), [visit('m', FRI, 'Lawn Mowing')]) === 'ok')
  // Blocked/warned: two mows <4 days apart.
  expect('mow Fri→Mon (3d) warned', chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: 'Lawn Mowing' }, addISO(FRI, 3), [visit('m', FRI, 'Lawn Mowing')]) === 'warn')
  expect('mow Fri→Sun (2d) warned', chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: 'Lawn Mowing' }, addISO(FRI, 2), [visit('m', FRI, 'Lawn Mowing')]) === 'warn')
  expect('mow same day collision', chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: 'Lawn Mowing' }, FRI, [visit('m', FRI, 'Lawn Mowing')]) === 'collision')
  // Allowed: different service categories adjacent (mow + others).
  for (const svc of ['Fertilization', 'Yard Cleanup', 'Mulch Installation', 'Snow Removal'])
    expect(`mow + ${svc} adjacent allowed`, chk({ id: 'x', customerId: 'C', recurrence_id: null, serviceType: svc }, addISO(FRI, 1), [visit('m', FRI, 'Lawn Mowing')]) === 'ok')
  // Per-customer: different customers' mows never conflict.
  expect('different customers not grouped', chk({ id: 'x', customerId: 'C2', recurrence_id: null, serviceType: 'Lawn Mowing' }, addISO(FRI, 1), [visit('m', FRI, 'Lawn Mowing', 'C1')]) === 'ok')
  // Cross-series, same customer + same category → protected.
  expect('cross-series same-cat protected', chk({ id: 'x', customerId: 'C', recurrence_id: 'rec-B', serviceType: 'Lawn Mowing' }, addISO(FRI, 2), [visit('m', FRI, 'Lawn Mowing', 'C', 'rec-A')]) === 'warn')
  // Service-key bucketing.
  expect('key: Lawn Mowing → mow', cadenceServiceKey('Lawn Mowing') === 'mow')
  expect('key: Weekly Mowing → mow', cadenceServiceKey('Weekly Mowing') === 'mow')
  expect('key: Monthly Service → mow', cadenceServiceKey('Monthly Service') === 'mow')
  expect('key: Fertilization ≠ mow', cadenceServiceKey('Fertilization') !== 'mow')
  expect('key: Snow Removal ≠ mow', cadenceServiceKey('Snow Removal') !== 'mow')
  expect('floor is flat 4', cadenceFloorFor(null, recs) === 4 && cadenceFloorFor('anything', recs) === 4)
  if (fails === 0) console.log('Same-category cadence rule ✓ (4-day floor, per service category)')
  return fails
}

// ── Run matrix ────────────────────────────────────────────────────────────────
function run() {
  const gen = genSchedule(42)
  const baseOpts = {
    today: TODAY, base: BASE as { lat: number; lng: number } | null,
    preferredDays: PREF_DAYS, capacityHours: CAP_HOURS, recurrences: gen.recs,
  }
  const cases: { name: string; scope: OptimizeScope; mode: OptimizeMode; anchor: string; jobs?: OptJob[]; base?: null }[] = [
    { name: 'future/recommended', scope: 'future', mode: 'recommended', anchor: TODAY },
    { name: 'future/density', scope: 'future', mode: 'density', anchor: TODAY },
    { name: 'future/balanced', scope: 'future', mode: 'balanced', anchor: TODAY },
    { name: 'future/revenue', scope: 'future', mode: 'revenue', anchor: TODAY },
    { name: 'week/balanced', scope: 'week', mode: 'balanced', anchor: addISO(TODAY, 7) },
    { name: 'week/density', scope: 'week', mode: 'density', anchor: addISO(TODAY, 7) },
    { name: 'day/balanced', scope: 'day', mode: 'balanced', anchor: addISO(TODAY, 7) },
    { name: 'noBase/density', scope: 'future', mode: 'density', anchor: TODAY, base: null },
  ]

  let failures = 0
  failures += testCadenceRule()
  const rows: Record<string, unknown>[] = []
  for (const c of cases) {
    const opts: OptOptions = { ...baseOpts, base: c.base === null ? null : baseOpts.base, mode: c.mode, scope: c.scope, anchorDate: c.anchor }
    const t0 = performance.now()
    const res = optimizeSchedule(gen.jobs, opts)
    const ms = Math.round((performance.now() - t0) * 10) / 10
    const res2 = optimizeSchedule(gen.jobs, opts)
    if (JSON.stringify(res.moves) !== JSON.stringify(res2.moves)) { failures++; console.error(`✗ ${c.name}: NON-DETERMINISTIC`) }
    const errs = validate(c.name, gen, opts, res)
    failures += errs.length
    for (const e of errs) console.error('✗ ' + e)
    // Cherry-pick math must agree with the engine at both extremes:
    // no moves selected → result.before; all moves selected → result.after.
    const mArgs = { scope: c.scope, anchorDate: c.anchor, today: TODAY, base: opts.base, capacityHours: CAP_HOURS }
    const mNone = metricsWithMoves(gen.jobs, mArgs, [])
    const mFull = metricsWithMoves(gen.jobs, mArgs, res.moves)
    if (JSON.stringify(mNone) !== JSON.stringify(res.before)) { failures++; console.error(`✗ ${c.name}: metricsWithMoves([]) != result.before`); console.error('  got ', mNone); console.error('  want', res.before) }
    if (JSON.stringify(mFull) !== JSON.stringify(res.after)) { failures++; console.error(`✗ ${c.name}: metricsWithMoves(all) != result.after`); console.error('  got ', mFull); console.error('  want', res.after) }
    rows.push({
      case: c.name, ms, moves: res.moves.length, blocked: res.blockedMoves,
      kmSaved: res.kmSaved, driveSaved: res.minutesSaved,
      'over b→a': `${res.before.overloadedDays}→${res.after.overloadedDays}`,
      'km b→a': `${res.before.totalKm}→${res.after.totalKm}`,
      'rev/h b→a': `${res.before.revPerHour}→${res.after.revPerHour}`,
      grouped: res.groupedIntoCluster,
    })
  }

  // Road-distance threading: a deterministic synthetic road function (asymmetric-
  // capable) must thread consistently — engine + metricsWithMoves agree, invariants
  // hold, deterministic.
  {
    const fakeRoad = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineKm(a, b) * 1.35 + 0.2
    const opts: OptOptions = { ...baseOpts, mode: 'density', scope: 'future', anchorDate: TODAY, roadDist: fakeRoad }
    const r1 = optimizeSchedule(gen.jobs, opts)
    const r2 = optimizeSchedule(gen.jobs, opts)
    if (JSON.stringify(r1.moves) !== JSON.stringify(r2.moves)) { failures++; console.error('✗ roadDist: NON-DETERMINISTIC') }
    failures += validate('roadDist/density', gen, opts, r1).length
    const mArgs = { scope: 'future' as OptimizeScope, anchorDate: TODAY, today: TODAY, base: opts.base, capacityHours: CAP_HOURS, roadDist: fakeRoad }
    const mFull = metricsWithMoves(gen.jobs, mArgs, r1.moves)
    if (JSON.stringify(mFull) !== JSON.stringify(r1.after)) { failures++; console.error('✗ roadDist: metricsWithMoves(all) != result.after') }
    const haverRes = optimizeSchedule(gen.jobs, { ...baseOpts, mode: 'density', scope: 'future', anchorDate: TODAY })
    if (failures === 0) console.log(`Road-distance threading ✓ (synthetic 1.35×: km ${haverRes.after.totalKm} haversine → ${r1.after.totalKm} road)`)
  }

  // analyzeSchedule end-to-end timing (the Schedule page workload).
  const tA = performance.now()
  const sugg = analyzeSchedule(gen.jobs, baseOpts)
  const msA = Math.round((performance.now() - tA) * 10) / 10
  rows.push({ case: 'analyzeSchedule', ms: msA, moves: sugg.length, blocked: '', kmSaved: '', driveSaved: '', 'over b→a': '', 'km b→a': '', 'rev/h b→a': '', grouped: '' })

  // Edge cases: empty, single, all-locked.
  const single = gen.jobs.slice(0, 1)
  const locked = gen.jobs.map(j => ({ ...j, invoiced: true }))
  for (const [nm, js] of [['empty', []], ['single', single], ['allLocked', locked]] as const) {
    const opts: OptOptions = { ...baseOpts, mode: 'recommended', scope: 'future', anchorDate: TODAY }
    const r = optimizeSchedule(js as OptJob[], opts)
    if (r.moves.length !== 0) { failures++; console.error(`✗ edge ${nm}: expected 0 moves, got ${r.moves.length}`) }
  }

  console.table(rows)
  const future = gen.jobs.filter(j => j.scheduled_date > TODAY && j.status === 'scheduled').length
  console.log(`jobs=${gen.jobs.length} future-scheduled=${future}`)
  if (failures > 0) { console.error(`\nFAILED: ${failures} invariant violation(s)`); process.exit(1) }
  console.log('\nAll invariants passed ✓')
}

run()
