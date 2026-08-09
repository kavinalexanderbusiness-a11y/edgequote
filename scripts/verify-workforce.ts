// ── Verify: the clock and the cheque describe the same week, and the same shift ─
//   npm run verify:workforce
//
// WHY THIS SCRIPT EXISTS
// Employee time is the one part of EdgeQuote where a wrong number is somebody's
// pay. The engines here (lib/timeTracking → lib/payroll → lib/payRun) are careful
// and were already right; every defect this file pins came instead from a SURFACE
// quietly deciding something the engine had already decided — a second opinion
// about what a week is, about who counts as staff, about how a duration rounds.
// tsc and `next build` cannot see any of it, because every wrong answer here is
// the same TYPE as the right one.
//
// Six properties, each a real defect found by audit and fixed alongside this file:
//
//  1. THE LIVE TIMER AND POSTGRES MUST AGREE. `minutes_worked` is a GENERATED
//     column and its `numeric::integer` cast ROUNDS. The running timer floored,
//     so a shift watched ticking to "7h 30m" saved as "7h 31m" — the UI and the
//     stored row describing different shifts on ~half of all clock-outs.
//
//  2. "THIS WEEK" IS THE WORK WEEK. The timesheet hardcoded Monday while overtime
//     is charged against business_settings.pay_week_starts_on. An owner on a
//     Sunday week checked "has Dave hit 44 yet" on a screen totalling a different
//     seven days from the one that decides what Dave is paid.
//
//  3. ARCHIVING SOMEONE CANNOT CHANGE WHAT THEY ARE OWED, AND CANNOT COST THEM
//     THEIR NAME. Gross is grouped off each shift's technician_id, so the roster
//     list cannot underpay — that invariant is pinned here so nobody "optimises"
//     payrollSummary into reading the roster instead. The list DOES decide
//     identity: anyone missing from it renders as the FORMER_EMPLOYEE_NAME placeholder and loses
//     their crew, which is why every paid-time surface loads it archived-inclusive.
//
//  4. A FORGOTTEN CLOCK-OUT MUST LOOK LIKE ONE. "On the clock since 8:14 AM" read
//     as this morning on a shift left open since Monday.
//
//  5. SHARES OF A WEEK ADD UP. The workload card divided each person's minutes by
//     every entry in the window while listing only current staff, so a departed
//     employee's shifts silently shrank everyone else's share.
//
//  6. A WEEK IS SEVEN DAYS. `addDays(endOfWeek(d), 1)` is the last millisecond of
//     the day AFTER the week — an eight-day window that swallows the next week's
//     first day.
//
// Runs the REAL engines against hand-built rows (no network, no DB, no API key).
// Deterministic — runs in CI beside the other verifiers.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDays, endOfWeek, startOfWeek } from 'date-fns'
import type { PtoEntry, Technician, TimeEntry } from '../src/types'
import { entryMinutes, spanMinutes, openSinceLabel, isStaleOpen, formatDuration } from '../src/lib/timeTracking'
import { payrollRules } from '../src/lib/payroll'
import { buildDraftPayRun } from '../src/lib/payRun'
import { overtimeInsight, workloadBalance } from '../src/lib/workforce'
import { FORMER_EMPLOYEE_NAME } from '../src/lib/workforceTeam'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const SRC = join(process.cwd(), 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Local wall-clock times on purpose: every boundary in this lane (work weeks, pay
// periods, "today") is a LOCAL calendar question, and building fixtures in UTC
// would hide exactly the timezone shifts the surfaces are supposed to survive.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s)
const iso = (dt: Date) => dt.toISOString()

let seq = 0
function shift(p: {
  tech: string; from: Date; to?: Date | null; breakMin?: number; rate?: number | null; jobId?: string | null
}): TimeEntry {
  seq++
  const minutes = p.to
    ? Math.max(0, spanMinutes(p.from.getTime(), p.to.getTime()) - (p.breakMin ?? 0))
    : null
  return {
    id: `entry-${seq}`, created_at: iso(p.from), updated_at: iso(p.from), user_id: 'owner',
    technician_id: p.tech, job_id: p.jobId ?? null,
    clock_in: iso(p.from), clock_out: p.to ? iso(p.to) : null,
    break_minutes: p.breakMin ?? 0,
    hourly_rate: p.rate === undefined ? 25 : p.rate,
    notes: null,
    // Mirrors the generated column. Tests that care about the DB's own arithmetic
    // compute it independently below rather than trusting this helper.
    minutes_worked: minutes,
  }
}

function tech(p: { id: string; name: string; wage?: number | null; archived?: boolean }): Technician {
  return {
    id: p.id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', user_id: 'owner',
    crew_id: null, name: p.name, phone: null, email: null, role: null,
    status: 'available', status_changed_at: '2026-01-01T00:00:00Z',
    // Archiving clears is_active too — see lib/crews.archiveTechnician.
    is_active: !p.archived,
    hourly_wage: p.wage === undefined ? 25 : p.wage,
    hired_on: null, ended_on: null, pto_annual_hours: null,
    archived_at: p.archived ? '2026-08-04T00:00:00Z' : null,
  }
}

/**
 * The generated column, transcribed from the live database:
 *   greatest(0, (extract(epoch from (clock_out - clock_in)) / 60)::integer - break)
 * `::integer` on a numeric rounds half AWAY FROM ZERO. Spans here are always
 * positive, so Math.round is exact.
 */
function postgresMinutesWorked(from: Date, to: Date, breakMin: number): number {
  const epochSeconds = (to.getTime() - from.getTime()) / 1000
  return Math.max(0, Math.round(epochSeconds / 60) - breakMin)
}

// ── 1. The live timer must predict the stored row ────────────────────────────
console.log('\nA running shift reads the same as the shift Postgres will store:')
{
  // 7h 30m 30s. Postgres: 450.5 → 451. Flooring gives 450 and shows "7h 30m"
  // right up to the instant the row saves as "7h 31m".
  const from = at(2026, 8, 5, 8, 0, 0)
  const to = at(2026, 8, 5, 15, 30, 30)
  const dbMinutes = postgresMinutesWorked(from, to, 0)
  eq('Postgres rounds 450.5 minutes up to 451', dbMinutes, 451)

  const open = shift({ tech: 't1', from, to: null })
  eq('the live timer agrees with it exactly', entryMinutes(open, to), dbMinutes)
  eq('…and so does the label the owner reads', formatDuration(entryMinutes(open, to)), '7h 31m')

  // Below the half minute both must round DOWN — a timer that always rounded up
  // would over-report every shift instead of under-reporting half of them.
  const shortTo = at(2026, 8, 5, 15, 30, 20)
  eq('under half a minute rounds down in Postgres', postgresMinutesWorked(from, shortTo, 0), 450)
  eq('…and in the live timer', entryMinutes(shift({ tech: 't1', from, to: null }), shortTo), 450)

  // Breaks come off AFTER the rounding, and the floor at 0 is real: a 20-minute
  // shift with a 30-minute break is 0 paid minutes, never -10.
  eq('an unpaid break is subtracted, never below zero',
    entryMinutes(shift({ tech: 't1', from, to: null, breakMin: 30 }), at(2026, 8, 5, 8, 20, 0)), 0)
  eq('…matching the DB', postgresMinutesWorked(from, at(2026, 8, 5, 8, 20, 0), 30), 0)

  // A CLOSED shift is never recomputed — the stored value wins even if it
  // disagrees with the timestamps, because the database is the authority.
  const closed = { ...shift({ tech: 't1', from, to }), minutes_worked: 999 }
  eq('a closed shift returns the DB value, never a recomputation', entryMinutes(closed), 999)
}

// ── 2. "This week" is the payroll work week ──────────────────────────────────
console.log('\nThe timesheet week is the week overtime is judged on:')
{
  // The owner's setting, through THE engine that reads it.
  eq('a Sunday work week resolves to 0', payrollRules({
    ot_daily_hours: 8, ot_weekly_hours: 44, ot_multiplier: 1.5,
    pay_period: 'biweekly', pay_period_anchor: null, pay_week_starts_on: 0,
  }).weekStartsOn, 0)
  eq('an unset work week falls back to Monday', payrollRules(null).weekStartsOn, 1)

  // Thu 2026-08-06. A Sunday week starts Aug 2; a Monday week starts Aug 3 — so a
  // shift worked on Sunday Aug 2 belongs to THIS week for the owner and to LAST
  // week for a screen that assumed Monday. That one shift is the bug.
  const thursday = at(2026, 8, 6, 12)
  const sundayWeek = startOfWeek(thursday, { weekStartsOn: 0 })
  const mondayWeek = startOfWeek(thursday, { weekStartsOn: 1 })
  eq('a Sunday week containing Thu Aug 6 starts Aug 2', sundayWeek.getDate(), 2)
  eq('a Monday week containing Thu Aug 6 starts Aug 3', mondayWeek.getDate(), 3)

  const sundayShift = shift({ tech: 't1', from: at(2026, 8, 2, 8), to: at(2026, 8, 2, 16) })
  check('Sunday Aug 2 falls inside the owner\'s week',
    new Date(sundayShift.clock_in) >= sundayWeek,
    'the Sunday shift must be inside a Sunday-start week')
  check('…and outside a hardcoded Monday week',
    new Date(sundayShift.clock_in) < mondayWeek,
    'the Sunday shift must fall outside a Monday-start week — this gap IS the defect')

  // The structural half: the timesheet must not decide this for itself.
  const timesheet = read('app/dashboard/dispatch/time/page.tsx')
  check('the timesheet asks lib/payroll what a week is',
    /payrollRules\(/.test(timesheet),
    'app/dashboard/dispatch/time/page.tsx must derive its week from payrollRules(settings), not from a literal')
  check('…and hardcodes no week start of its own',
    !/weekStartsOn:\s*\d/.test(timesheet),
    'a numeric weekStartsOn literal is a second opinion about the work week — pass the value payrollRules returned')
}

// ── 3. Archiving changes identity, never pay ─────────────────────────────────
console.log('\nArchiving someone changes their name on the sheet, never their pay:')
{
  const rules = payrollRules({
    ot_daily_hours: null, ot_weekly_hours: null, ot_multiplier: 1.5,
    pay_period: 'weekly', pay_period_anchor: null, pay_week_starts_on: 1,
  })
  const period = { kind: 'weekly' as const, start: at(2026, 8, 3), end: at(2026, 8, 9), label: 'Aug 3 – 9' }

  const staying = tech({ id: 't1', name: 'Dana' })
  const departed = tech({ id: 't2', name: 'Sam', archived: true })
  const entries = [
    shift({ tech: 't1', from: at(2026, 8, 4, 8), to: at(2026, 8, 4, 16) }),   // 8h @ $25 = $200
    shift({ tech: 't2', from: at(2026, 8, 3, 8), to: at(2026, 8, 3, 16) }),   // 8h @ $25 = $200
  ]
  const ptoEntries: PtoEntry[] = []

  const whole = buildDraftPayRun({ entries, ptoEntries, technicians: [staying, departed], rules, period })
  const rosterOnly = buildDraftPayRun({ entries, ptoEntries, technicians: [staying], rules, period })

  eq('the full roster pays both people', whole.grossPay, 400)
  eq('…and lists both', whole.employeeCount, 2)

  // THE INVARIANT: pay is grouped off the shift's own technician_id, so who is on
  // the roster today cannot change what last fortnight cost. Archiving a person
  // must never be a way to stop owing them.
  eq('gross does not depend on the roster list', rosterOnly.grossPay, whole.grossPay)
  eq('…and neither does the headcount on the sheet', rosterOnly.employeeCount, whole.employeeCount)

  // What the list DOES decide. This is the whole reason for includeArchived.
  check('the full roster names the departed employee',
    whole.lines.some(l => l.technicianName === 'Sam'),
    'a pay stub for the former-employee placeholder is not a pay stub')
  check('an active-only roster loses their name',
    rosterOnly.lines.some(l => l.technicianName === FORMER_EMPLOYEE_NAME),
    'omitting an archived employee must degrade their name — if it no longer does, this test has stopped proving anything')

  // Every surface that turns hours into money must load the archived-inclusive
  // roster. Checked over the source because the flag is a call-site decision that
  // no type can enforce.
  const MONEY_SURFACES = [
    'app/dashboard/workforce/page.tsx',
    'app/dashboard/dispatch/payroll/page.tsx',
    'app/dashboard/dispatch/payroll/history/[id]/page.tsx',
    'app/dashboard/dispatch/time/page.tsx',
    'app/dashboard/dispatch/labor/page.tsx',
  ]
  for (const f of MONEY_SURFACES) {
    const src = read(f)
    check(`${f} loads the roster with includeArchived`,
      // `[^)]` already spans newlines, so no dotAll flag (which the TS target
      // predates) is needed to cross a wrapped, commented call.
      /loadTechnicians\([^)]*includeArchived:\s*true/.test(src),
      'this surface computes or replays pay, so it must pass { includeArchived: true } — see lib/crews.loadTechnicians')
  }
}

// ── 4. A forgotten clock-out looks like one ──────────────────────────────────
console.log('\nAn open shift says which day it started:')
{
  const now = at(2026, 8, 6, 14, 0)
  const startedToday = shift({ tech: 't1', from: at(2026, 8, 6, 8, 14), to: null })
  const startedMonday = shift({ tech: 't2', from: at(2026, 8, 3, 8, 14), to: null })

  eq('today\'s shift says only the time', openSinceLabel(startedToday.clock_in, now), '8:14 AM')
  eq('an older one names the day', openSinceLabel(startedMonday.clock_in, now), 'Mon Aug 3, 8:14 AM')

  eq('today\'s shift is not flagged stale', isStaleOpen(startedToday, now), false)
  eq('Monday\'s open shift is', isStaleOpen(startedMonday, now), true)
  // A CLOSED shift is never "stale open", however old it is — the flag means
  // "still running", not "in the past".
  eq('a closed shift is never stale-open',
    isStaleOpen(shift({ tech: 't1', from: at(2026, 8, 3, 8), to: at(2026, 8, 3, 16) }), now), false)

  // The number that gave the game away, kept honest: three days, not a morning.
  eq('and its duration is the real elapsed time', formatDuration(entryMinutes(startedMonday, now)), '77h 46m')
}

// ── 5. Shares of the week add up ─────────────────────────────────────────────
console.log('\nThe workload split adds up to the week it describes:')
{
  const ctx = { crewNames: new Map<string, string>() }
  const staying = [tech({ id: 't1', name: 'Dana' }), tech({ id: 't2', name: 'Ada' })]
  const entries = [
    shift({ tech: 't1', from: at(2026, 8, 4, 8), to: at(2026, 8, 4, 16) }),   // 480
    shift({ tech: 't2', from: at(2026, 8, 4, 8), to: at(2026, 8, 4, 16) }),   // 480
    // A departed employee's shifts are still in the window — they were worked.
    shift({ tech: 't3', from: at(2026, 8, 5, 8), to: at(2026, 8, 5, 16) }),   // 480
  ]
  const balance = workloadBalance(entries, staying, ctx)
  eq('only current staff hold a share', balance.people, 2)
  const sum = Math.round(balance.shares.reduce((s, x) => s + x.sharePct, 0))
  eq('and the shares total 100%', sum, 100)
  eq('the denominator is the listed people\'s minutes', balance.totalMinutes, 960)
  eq('an even split of two is 50%', balance.evenSharePct, 50)
}

// ── 6. A week is seven days ──────────────────────────────────────────────────
console.log('\nThe overtime week is exactly seven days:')
{
  const rules = payrollRules({
    ot_daily_hours: null, ot_weekly_hours: 40, ot_multiplier: 1.5,
    pay_period: 'weekly', pay_period_anchor: null, pay_week_starts_on: 1,
  })
  const people = [tech({ id: 't1', name: 'Dana' })]
  const anchor = at(2026, 8, 5, 12)              // Wed Aug 5
  const weekStart = startOfWeek(anchor, { weekStartsOn: 1 })   // Mon Aug 3
  const weekEnd = endOfWeek(anchor, { weekStartsOn: 1 })       // Sun Aug 9, 23:59:59.999

  const inside = shift({ tech: 't1', from: at(2026, 8, 9, 8), to: at(2026, 8, 9, 16) })   // Sun — in
  const nextWeek = shift({ tech: 't1', from: at(2026, 8, 10, 8), to: at(2026, 8, 10, 16) }) // Mon — out

  const only = overtimeInsight({ technicians: people, entries: [inside], rules, weekStart, weekEnd })
  eq('the week\'s last day counts', only.watch[0]?.minutesSoFar, 480)

  const both = overtimeInsight({ technicians: people, entries: [inside, nextWeek], rules, weekStart, weekEnd })
  eq('the next week\'s first day does not', both.watch[0]?.minutesSoFar, 480)

  // And the boundary the page filters on has to be the same one.
  const upper = addDays(new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate()), 1).getTime()
  check('the exclusive upper bound is midnight after the last day',
    new Date(inside.clock_in).getTime() < upper && new Date(nextWeek.clock_in).getTime() >= upper,
    'startOfDay(weekEnd) + 1 day is the only bound that makes the window seven days')
}

if (failures) {
  console.log(`\n❌ verify:workforce — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:workforce — the clock, the week and the cheque agree\n')
