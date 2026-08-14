// ── Verify: work sessions, and the ONE number a job's time adds up to ────────
//   npm run verify:work-sessions
//
// WHY THIS SCRIPT EXISTS
//
// `jobs.actual_minutes` is written by SIX doors — the calendar's Done, the Day
// Ops status dropdown, the job form, lib/jobStatus' check-out,
// /api/crew/complete, and the offline outbox replaying any of them. Session 47
// added a seventh source of the same fact: an itemised ledger of work sessions.
// Two representations of one quantity is how "actual_minutes = 300, sessions
// total 480" happens, and nothing in tsc or `next build` can see it coming: both
// are valid integers.
//
// So the contract is asserted as BEHAVIOUR, against the real database, in both
// directions — the total follows its parts, and a caller who writes a
// disagreeing total is corrected rather than believed.
//
// It also pins the two things this feature is defined by NOT doing:
//   ⛔ Stopping for the day must never complete the job (no status 'completed',
//      no invoice engine reachable from the stop path).
//   ⛔ A workday must never be 24 hours, and must never be hard-coded.
//
// ⭐ EVERY LIVE WRITE GOES THROUGH THE FIXTURE TENANT (scripts/lib/verify-fixture),
// per [verify-fixture-isolation]: a guard that creates jobs fires the same
// triggers a real job does, and those must never land in the owner's book.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  WORKDAY_FALLBACK_HOURS, describeWorkday, durationValueText, formatDuration,
  formatWorked, splitDuration, toMinutes, workdayIsCustom, workdayMinutes,
} from '../src/lib/workDuration'
import {
  describeLabour, describeWork, sessionTotals, sessionsByDay, validateWorkInput, workProgress,
} from '../src/lib/workSession'
import { buildTimeline } from '../src/lib/timeline'
import type { WorkSession } from '../src/types'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const src = (p: string) => readFileSync(p, 'utf8')
/** Comments explain the rules, so a scan of raw text finds the forbidden word in
 *  the prose that forbids it. Strip comments before asserting over code.
 *  ⚠️ `[^\n]` rather than `.` — CRLF files defeat `.*$`. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\n]*\/\/[^\n]*$/gm, '')
/** SQL comments are `--`, not `//`. Running the TypeScript stripper over a
 *  migration leaves every comment in place, so a header sentence promising "no
 *  wage appears in this file" reads as the wage it forbids. */
const sql = (s: string) => s.replace(/--[^\n]*/g, '')

const session = (o: Partial<WorkSession> & { minutes: number }): WorkSession => ({
  id: randomUUID(), user_id: 'u', job_id: 'j', worked_on: '2026-08-14',
  started_at: null, ended_at: null, workers: 1,
  labour_minutes: o.minutes * (o.workers ?? 1), note: null, source: 'manual',
  created_at: '2026-08-14T12:00:00Z', updated_at: '2026-08-14T12:00:00Z', ...o,
})

// ═══ 1. A workday is the business's own day, never 24 hours ══════════════════
console.log('\n═══ The workday ═══')

const EIGHT = 8 * 60
eq('an unset capacity falls back to the same 8h every other reader uses',
  workdayMinutes(null), EIGHT)
eq('…and so does an unset-as-undefined', workdayMinutes(undefined), EIGHT)
eq('a 6-hour business gets a 6-hour day', workdayMinutes(6), 360)
eq('a 10-hour business gets a 10-hour day', workdayMinutes(10), 600)
eq('a half-hour is not lost', workdayMinutes(7.5), 450)

// ⭐⭐ THE rule this feature was told to get right. A "day" that meant 24 hours
// would make "2 days" mean 2880 minutes of labour on every estimate in the book.
check('⭐ a workday is NEVER 24 hours',
  workdayMinutes(null) !== 24 * 60 && workdayMinutes(8) !== 24 * 60,
  'a workday resolved to 1440 minutes — a calendar day, not a working one')
eq('a capacity longer than a real day is clamped to one', workdayMinutes(99), 24 * 60)
// dayFit reads an explicit 0 as "this day is blocked". As a UNIT of measurement
// zero is not a quantity, so it falls back here rather than dividing by zero.
eq('a zero capacity is a fallback here, not a divide-by-zero', workdayMinutes(0), EIGHT)
eq('…and so is a negative one', workdayMinutes(-5), EIGHT)

eq('the workday is described as a WORKING day', describeWorkday(EIGHT), '8-hour day')
eq('…and a fractional one reads cleanly', describeWorkday(450), '7.5-hour day')
check('a business on the default is not told about it', !workdayIsCustom(EIGHT))
check('…and one on its own day is', workdayIsCustom(360))

// ═══ 2. Value + unit → one stored integer of minutes ═════════════════════════
console.log('\n═══ Duration: value + unit ═══')

// The three inputs the owner named, normalising consistently.
eq('90 minutes → 90', toMinutes(90, 'minutes', EIGHT), 90)
eq('1.5 hours → 90', toMinutes(1.5, 'hours', EIGHT), 90)
eq('2 hours → 120', toMinutes(2, 'hours', EIGHT), 120)
eq('…and they are the same stored number',
  [toMinutes(90, 'minutes', EIGHT), toMinutes(1.5, 'hours', EIGHT)], [90, 90])
eq('a typed string is accepted (an input box holds strings)', toMinutes('2', 'hours', EIGHT), 120)
eq('whitespace does not defeat it', toMinutes(' 2 ', 'hours', EIGHT), 120)

eq('1 workday on an 8h business → 480', toMinutes(1, 'days', EIGHT), 480)
eq('1 workday on a 6h business → 360', toMinutes(1, 'days', 360), 360)
eq('3 workdays on a 10h business → 1800', toMinutes(3, 'days', 600), 1800)
eq('half a workday is allowed', toMinutes(0.5, 'days', EIGHT), 240)
eq('a fraction of a minute is rounded to a minute', toMinutes(1.007, 'hours', EIGHT), 60)

// ⭐ NOT STATED and ZERO are different, all the way to the nullable column.
eq('a blank box is "not sized", not zero', toMinutes('', 'hours', EIGHT), null)
eq('zero is not a duration', toMinutes(0, 'hours', EIGHT), null)
eq('a negative is not a duration', toMinutes(-3, 'hours', EIGHT), null)
eq('nonsense is not a duration', toMinutes('abc', 'hours', EIGHT), null)
eq('null is not a duration', toMinutes(null, 'hours', EIGHT), null)

// The unit follows the value back out, so re-opening a job shows what was meant.
eq('480 on an 8h business reads back as 1 workday', splitDuration(480, EIGHT), { value: 1, unit: 'days' })
eq('720 reads back as 1.5 workdays', splitDuration(720, EIGHT), { value: 1.5, unit: 'days' })
eq('120 reads back as 2 hours', splitDuration(120, EIGHT), { value: 2, unit: 'hours' })
eq('90 reads back as 1.5 hours', splitDuration(90, EIGHT), { value: 1.5, unit: 'hours' })
eq('50 reads back as 50 minutes', splitDuration(50, EIGHT), { value: 50, unit: 'minutes' })
eq('45 reads back as 45 minutes', splitDuration(45, EIGHT), { value: 45, unit: 'minutes' })
eq('nothing reads back as an empty minutes box', splitDuration(null, EIGHT), { value: 0, unit: 'minutes' })
// The same stored number says different things to different businesses — which
// is the entire reason the workday is a setting and not a constant.
eq('360 is 1 workday to a 6h business', splitDuration(360, 360), { value: 1, unit: 'days' })
eq('…and 6 hours to an 8h one', splitDuration(360, EIGHT), { value: 6, unit: 'hours' })

// ROUND TRIP: what a person types must survive being read back.
for (const [v, u] of [[90, 'minutes'], [2, 'hours'], [1.5, 'hours'], [3, 'days'], [0.5, 'days']] as const) {
  const stored = toMinutes(v, u, EIGHT)!
  const back = splitDuration(stored, EIGHT)
  check(`round trip: ${v} ${u} → ${stored}m → ${back.value} ${back.unit}`,
    toMinutes(back.value, back.unit, EIGHT) === stored,
    `re-reading ${stored} produced ${back.value} ${back.unit}, which is not the same duration`)
}
eq('an input box never shows a trailing zero', durationValueText(2), '2')
eq('…but does show a real half', durationValueText(1.5), '1.5')

eq('a planned 45 minutes reads "45m"', formatDuration(45, EIGHT), '45m')
eq('a planned 2 hours reads "2h"', formatDuration(120, EIGHT), '2h')
eq('a planned 90 minutes reads "1h 30m"', formatDuration(90, EIGHT), '1h 30m')
eq('a planned workday reads "1 day"', formatDuration(480, EIGHT), '1 day')
eq('two and a bit reads "2 days 2h"', formatDuration(1080, EIGHT), '2 days 2h')
eq('an unsized job says nothing at all', formatDuration(null, EIGHT), '')
eq('…and zero says nothing either', formatDuration(0, EIGHT), '')
// Below one working day, days are a worse answer than hours for every trade.
check('a job shorter than a workday is never described in days',
  !/day/.test(formatDuration(470, EIGHT)), '"0.98 days" is not how anyone sizes work')

// ⭐ MEASURED time is never re-stated in workdays.
eq('worked time reads in hours and minutes', formatWorked(200), '3h 20m')
eq('…exactly as the owner asked for it', formatWorked(310), '5h 10m')
eq('a whole hour drops the minutes', formatWorked(120), '2h')
eq('under an hour is minutes alone', formatWorked(45), '45m')
eq('nothing worked says nothing', formatWorked(null), '')
check('⭐ a full workday of RECORDED time still reads in hours, never "1 day"',
  formatWorked(480) === '8h',
  'recorded history was re-expressed through a setting that can change tomorrow')
check('…and so does a multi-day total', formatWorked(1500) === '25h',
  'a measured total was converted into workdays')

// ═══ 3. Elapsed time vs labour time ══════════════════════════════════════════
console.log('\n═══ Elapsed vs labour ═══')

const threeForTwoHours = [session({ minutes: 120, workers: 3, worked_on: '2026-08-14' })]
const t1 = sessionTotals(threeForTwoHours)
// ⭐⭐ THE distinction the owner named: three workers, two hours.
eq('⭐ three people for two hours: elapsed is 2 hours', t1.elapsedMinutes, 120)
eq('⭐ …and labour is 6 person-hours', t1.labourMinutes, 360)
check('the two are genuinely different numbers', t1.elapsedMinutes !== t1.labourMinutes)

const solo = sessionTotals([session({ minutes: 120, workers: 1 })])
eq('for a solo operator they are one number', [solo.elapsedMinutes, solo.labourMinutes], [120, 120])
check('…so labour is not printed twice', describeLabour(solo) === '',
  'a solo visit was told its own elapsed time again, labelled "labour"')
check('a crew visit DOES say its labour', describeLabour(t1) === '6h of labour')

const multi = [
  session({ minutes: 200, workers: 1, worked_on: '2026-08-14' }),
  session({ minutes: 310, workers: 2, worked_on: '2026-08-15' }),
  session({ minutes: 60, workers: 2, worked_on: '2026-08-15' }),
]
const t2 = sessionTotals(multi)
eq('elapsed sums across every session', t2.elapsedMinutes, 570)
eq('labour weights each session by its own crew', t2.labourMinutes, 200 + 620 + 120)
// Two sessions on one day is not two days — capacity maths reads this.
eq('DAYS counts distinct days, not sessions', t2.days, 2)
eq('…while the session count is its own figure', t2.count, 3)
eq('the span is reported from the days worked', [t2.firstDay, t2.lastDay], ['2026-08-14', '2026-08-15'])
check('a job worked by different numbers of people says so', t2.workersVaried)
check('…and a consistent crew does not', !sessionTotals([
  session({ minutes: 60, workers: 2 }), session({ minutes: 90, workers: 2 }),
]).workersVaried)
eq('a job with no work described says nothing', describeWork(sessionTotals([])), '')
eq('…rather than "0 sessions"', describeWork(t2), '3 sessions over 2 days · 9h 30m')
eq('one session on one day reads in the singular', describeWork(sessionTotals([session({ minutes: 45 })])), '1 session · 45m')
eq('sessions group by the day they were worked', sessionsByDay(multi).map(d => [d.day, d.sessions.length]),
  [['2026-08-14', 1], ['2026-08-15', 2]])

// ═══ 4. In progress, and NOT complete ════════════════════════════════════════
console.log('\n═══ Stopping without finishing ═══')

const running = workProgress({ status: 'in_progress', started_at: '2026-08-14T09:00:00Z', duration_minutes: 480 }, multi)
const paused = workProgress({ status: 'in_progress', started_at: null, duration_minutes: 480 }, multi)
const done = workProgress({ status: 'completed', started_at: null, duration_minutes: 480 }, multi)
const fresh = workProgress({ status: 'scheduled', started_at: null, duration_minutes: 480 }, [])

// ⭐⭐ THE state that makes multi-day work expressible with no new status.
eq('⭐ underway with the clock running is "in progress", running', [running.stage, running.running, running.paused], ['in_progress', true, false])
eq('⭐ underway with NO clock is still "in progress" — and paused', [paused.stage, paused.running, paused.paused], ['in_progress', false, true])
check('⭐ stopping for the day does NOT make a job complete', paused.stage !== 'complete',
  'a stopped job reported itself finished — the one thing this feature must never do')
eq('a finished job is complete', done.stage, 'complete')
eq('a job nobody has touched has not started', [fresh.stage, fresh.paused], ['not_started', false])
eq('a cancelled visit is neither', workProgress({ status: 'cancelled', started_at: null, duration_minutes: 60 }, []).stage, 'cancelled')
// Work recorded against a job the office has not moved off 'scheduled' is still
// work: the ledger outranks the status flag for "has anything happened".
eq('recorded work makes a job underway even if the status lagged',
  workProgress({ status: 'scheduled', started_at: null, duration_minutes: 60 }, multi).stage, 'in_progress')

// ⭐ NO FAKE PERCENTAGES. Every branch where either side is unknown is null.
eq('time against estimate is a ratio, not a completion claim', running.estimateUsed, 570 / 480)
eq('an unsized job has no ratio',
  workProgress({ status: 'in_progress', started_at: null, duration_minutes: null }, multi).estimateUsed, null)
eq('…and neither does one with nothing recorded',
  workProgress({ status: 'in_progress', started_at: null, duration_minutes: 480 }, []).estimateUsed, null)
eq('a zero estimate is "not sized", not a divide-by-zero',
  workProgress({ status: 'in_progress', started_at: null, duration_minutes: 0 }, multi).estimateUsed, null)

// Input bounds, worded for the field rather than as a constraint name.
eq('a session must record some time', validateWorkInput({ workedOn: '2026-08-14', minutes: 0 }), 'Enter how long the work took.')
check('…and a plausible amount of it',
  /more than a week/.test(validateWorkInput({ workedOn: '2026-08-14', minutes: 20000 }) ?? ''),
  'a 14-day single session was accepted as one stretch of work')
eq('at least one person was there', validateWorkInput({ workedOn: '2026-08-14', minutes: 60, workers: 0 }), 'At least one person has to have been there.')
eq('a day is required', validateWorkInput({ workedOn: 'soon', minutes: 60 }), 'Pick the day the work happened.')
eq('a good session passes', validateWorkInput({ workedOn: '2026-08-14', minutes: 195, workers: 2 }), null)

// ═══ 5. History without clutter ══════════════════════════════════════════════
console.log('\n═══ The timeline ═══')

const tlJob = {
  id: 'j1', title: 'Project', scheduled_date: '2026-08-14', status: 'completed',
  created_at: '2026-08-10T09:00:00Z', updated_at: '2026-08-15T18:00:00Z',
  completed_at: '2026-08-15T18:00:00Z', actual_minutes: 510, property_id: null, recurrence_id: null,
}
const twoDays = buildTimeline({
  jobs: [tlJob],
  workSessions: [
    { id: 'w1', job_id: 'j1', worked_on: '2026-08-14', minutes: 200, workers: 1, note: null },
    { id: 'w2', job_id: 'j1', worked_on: '2026-08-15', minutes: 310, workers: 2, note: null },
  ],
})
// buildTimeline returns sorted — NEWEST FIRST, like every other history surface.
const worked = twoDays.filter(e => e.kind === 'work_session')
eq('a job worked over two days shows both days, newest first',
  worked.map(e => e.title), ['Worked 5h 10m', 'Worked 3h 20m'])
check('…in the owner\'s own words', worked.some(e => e.title === 'Worked 3h 20m'))
check('…and each sits on the day it was worked',
  worked[0].at.startsWith('2026-08-15') && worked[1].at.startsWith('2026-08-14'),
  `dates were ${worked.map(e => e.at).join(', ')}`)
check('…and the crew size when there was one', worked[0].sub === '2 people',
  `expected "2 people", got ${JSON.stringify(worked[0].sub)}`)
check('…and says nothing extra about a solo day', worked[1].sub === undefined,
  `a one-person day claimed ${JSON.stringify(worked[1].sub)}`)
check('…alongside the completion, not instead of it',
  twoDays.some(e => e.kind === 'job_completed'), 'the completion vanished from the history')

// ⭐⭐ THE ANTI-CLUTTER RULE. Every routine visit in the book has one session.
const oneDay = buildTimeline({
  jobs: [tlJob],
  workSessions: [{ id: 'w1', job_id: 'j1', worked_on: '2026-08-15', minutes: 45, workers: 1, note: null }],
})
check('⭐ a job worked on ONE day adds no work rows — the completion already says it',
  oneDay.filter(e => e.kind === 'work_session').length === 0,
  'every ordinary visit would grow a duplicate "Worked 45m" line beside its completion')
check('…and that job still has its completion', oneDay.some(e => e.kind === 'job_completed'))
// The rule is per JOB, not per timeline: one busy job must not make a quiet one noisy.
const mixed = buildTimeline({
  jobs: [tlJob, { ...tlJob, id: 'j2' }],
  workSessions: [
    { id: 'a', job_id: 'j1', worked_on: '2026-08-14', minutes: 120, workers: 1, note: null },
    { id: 'b', job_id: 'j1', worked_on: '2026-08-15', minutes: 120, workers: 1, note: null },
    { id: 'c', job_id: 'j2', worked_on: '2026-08-15', minutes: 45, workers: 1, note: null },
  ],
})
eq('the rule is judged per job, not across the timeline',
  mixed.filter(e => e.kind === 'work_session').length, 2)
check('a timeline with no sessions at all is unchanged',
  buildTimeline({ jobs: [tlJob] }).filter(e => e.kind === 'work_session').length === 0)

// ═══ 6. What the code may not do ═════════════════════════════════════════════
console.log('\n═══ The boundaries, over the real source ═══')

const engine = src('src/lib/workSession.ts')
const sheet = src('src/components/jobs/StopForTodaySheet.tsx')
const migration = src('supabase/RUN-2026-08-13-work-sessions.sql')
const durationEngine = src('src/lib/workDuration.ts')

// ⛔ STOP MUST NOT COMPLETE. Asserted over the code, not the comments.
check('⛔ the stop path never writes a completed status',
  !/status:\s*'completed'/.test(code(engine)),
  'lib/workSession can set a job to completed — "Stop for today" could finish a job')
check('⛔ …and no invoice engine is reachable from it',
  !/invoic/i.test(code(engine)),
  'the work-session engine can reach invoicing; stopping for the day could bill a customer')
check('⛔ …and it sends no customer message',
  !/comms\/send|template:/.test(code(engine)),
  'stopping for the day could text a customer that the work is done')
check('⛔ the stop sheet never offers the word "Complete"',
  !/Complete/.test(code(sheet)),
  'the sheet whose entire job is NOT completing offered a Complete control')
check('the stop path does write in_progress',
  /status:\s*'in_progress'/.test(code(engine)),
  'stopping for the day no longer leaves the job underway')

// ⛔ NOT PAYROLL, NOT SURVEILLANCE.
check('⛔ a work session carries no wage',
  !/hourly_rate|hourly_wage|wage|payroll/i.test(code(engine)) && !/hourly_rate|hourly_wage|wage/i.test(sql(migration)),
  'a pay rate entered the work-session lane — this is not payroll')
check('⛔ …and names no person',
  !/technician_id/.test(code(engine)) && !/technician_id/.test(sql(migration)),
  'a work session can identify who was on site — workers is a COUNT, never a roster')
check('⛔ …and it is not a second read of time_entries',
  !/time_entries/.test(code(engine)),
  'the work-session engine reads the payroll clock — two answers to one question')

// ⭐ THE TENANCY BOUNDARY — the hole that was live on three tables until 2026-08-11.
check('⭐ the job pointer is a COMPOSITE foreign key',
  /foreign key\s*\(\s*job_id\s*,\s*user_id\s*\)\s*references\s+public\.jobs\s*\(\s*id\s*,\s*user_id\s*\)/i.test(migration),
  'job_id is a single-column FK: RLS proves who owns the session, the FK proves the job exists, and NOTHING proves they are the same business')
check('⭐ RLS is on, and scoped to the owner',
  /alter table public\.job_work_sessions enable row level security/i.test(migration)
  && (migration.match(/auth\.uid\(\) = user_id/g) || []).length >= 4,
  'the work-session table is not owner-scoped on all four verbs')
// ⛔ NO CREW POLICY. A crew session holds no table grants at all by design; its
// writes ride the DEFINER path. A policy here would be the way around that.
// Asserted over the POLICY statements themselves rather than the word "crew",
// which legitimately appears as `crew_size` (the planned headcount a banked
// session records) throughout the trigger bodies.
const policies = sql(migration).match(/create policy[\s\S]*?;/gi) || []
check('⛔ no crew RLS policy was added',
  policies.length > 0 && policies.every(p => !/crew/i.test(p)),
  `a crew policy on job_work_sessions would hand a worker direct table access — crew writes go through the DEFINER path (policies: ${policies.length})`)
check('…and no crew identity function is consulted anywhere in it',
  !/crew_employer|crew_crew_id|crew_session/i.test(sql(migration)),
  'the work-session schema consults crew identity — that boundary lives in the crew RPCs')
check('nothing is granted to anon',
  !/grant[^;]*\banon\b/i.test(sql(migration)),
  'work history is internal; anon must not reach it')

// ⭐ THE WORKDAY IS A SETTING, NOT A CONSTANT.
check('⭐ the duration engine reads the workday from the business, never a literal day',
  !/\b1440\b/.test(code(durationEngine).replace(/24 \* 60/g, '')),
  'a 24-hour day was hard-coded into the duration engine')
check('…and the 8-hour fallback is the one the rest of the app already uses',
  WORKDAY_FALLBACK_HOURS === 8,
  'the duration fallback drifted from every other daily_capacity_hours reader')
check('the job form reads daily_capacity_hours rather than assuming a day',
  /daily_capacity_hours/.test(src('src/components/schedule/JobForm.tsx')),
  'the duration control invented its own workday instead of reading the setting')
check('…and passes it to the control',
  /workdayMin=\{workdayMin\}/.test(src('src/components/schedule/JobForm.tsx')),
  'the duration control is not being told this business\'s workday')

// ⭐ THE TOTAL IS THE DATABASE'S. No surface recomputes and writes it back.
check('⭐ the panel never writes actual_minutes',
  !/actual_minutes\s*[:=]/.test(code(src('src/components/jobs/WorkSessionsPanel.tsx'))),
  'a surface computes the job total itself — the database owns it')
check('the trigger recomputes from a re-read sum, never a delta',
  /job_session_minutes\(/.test(migration) && !/actual_minutes\s*[+-]=/.test(migration),
  'the total is maintained by arithmetic on a previous value, which drifts')

// ⚠️ The nested-trigger guard that stops Postgres refusing the whole write.
check('the session→job propagation is guarded against its own nesting',
  /pg_trigger_depth\(\)\s*>\s*1/.test(migration),
  'a BEFORE trigger cascading onto its own row raises "tuple to be updated was already modified"')
check('a re-closed check-in extends its stretch rather than being dropped',
  /on conflict[\s\S]{0,200}do update set[\s\S]{0,200}greatest\(/i.test(migration),
  'closing the same check-in twice silently banks nothing — the afternoon disappears')

// ── The live half: the contract, against the real database ───────────────────
async function liveChecks() {
  console.log('\n═══ The one-number contract, against the database ═══')
  const t = await openFixtureTenant('verify:work-sessions')
  if (isSkipped(t)) {
    console.log(`  · live half skipped — ${t.skipped}`)
    return
  }
  const jobIds: string[] = []
  const newJob = async (patch: Record<string, unknown> = {}) => {
    const { data, error } = await t.db.from('jobs').insert({
      user_id: t.uid, title: t.tag('WORKSESSION'), scheduled_date: '2026-08-14',
      status: 'scheduled', crew_size: 1, duration_minutes: 480, ...patch,
    }).select('id, actual_minutes, status, started_at').single()
    if (error || !data) throw new Error(`could not create the fixture job: ${error?.message}`)
    jobIds.push((data as { id: string }).id)
    return data as { id: string; actual_minutes: number | null; status: string; started_at: string | null }
  }
  const readJob = async (id: string) => {
    const { data } = await t.db.from('jobs').select('actual_minutes, status, started_at').eq('id', id).single()
    return data as { actual_minutes: number | null; status: string; started_at: string | null }
  }
  const addSession = async (id: string, patch: Record<string, unknown>) =>
    t.db.from('job_work_sessions').insert({
      user_id: t.uid, job_id: id, worked_on: '2026-08-14', minutes: 60, ...patch,
    }).select('id, minutes, workers, labour_minutes').single()

  try {
    // ── The total follows its parts ──
    const a = await newJob()
    eq('a job with no sessions records nothing — null, never 0', a.actual_minutes, null)
    await addSession(a.id, { minutes: 200, workers: 1, worked_on: '2026-08-14' })
    eq('one session sets the total', (await readJob(a.id)).actual_minutes, 200)
    await addSession(a.id, { minutes: 310, workers: 2, worked_on: '2026-08-15' })
    eq('a second day ADDS to it', (await readJob(a.id)).actual_minutes, 510)

    // ⭐⭐ THE headline: a caller who writes a disagreeing total is corrected.
    await t.db.from('jobs').update({ actual_minutes: 9999 }).eq('id', a.id)
    eq('⭐ a total that disagrees with its parts is refused',
      (await readJob(a.id)).actual_minutes, 510)
    await t.db.from('jobs').update({ actual_minutes: 42 }).eq('id', a.id)
    eq('⭐ …in the other direction too', (await readJob(a.id)).actual_minutes, 510)

    // Corrections to history move the total with them.
    const { data: sess } = await t.db.from('job_work_sessions')
      .select('id, minutes').eq('job_id', a.id).eq('minutes', 200).single()
    await t.db.from('job_work_sessions').update({ minutes: 60 }).eq('id', (sess as { id: string }).id)
    eq('correcting a session moves the total', (await readJob(a.id)).actual_minutes, 370)
    await t.db.from('job_work_sessions').delete().eq('id', (sess as { id: string }).id)
    eq('deleting one takes its time with it', (await readJob(a.id)).actual_minutes, 310)
    await t.db.from('job_work_sessions').delete().eq('job_id', a.id)
    eq('⭐ deleting the last one returns to UNKNOWN, never zero',
      (await readJob(a.id)).actual_minutes, null)

    // ── labour_minutes is the database's arithmetic ──
    const b = await newJob({ crew_size: 3 })
    const { data: three } = await addSession(b.id, { minutes: 120, workers: 3 })
    eq('⭐ three people for two hours: 120 elapsed, 360 labour',
      [(three as { minutes: number }).minutes, (three as { labour_minutes: number }).labour_minutes], [120, 360])
    eq('…and the job total stays ELAPSED', (await readJob(b.id)).actual_minutes, 120)

    // ── Stop for today: the clock banks, the job stays underway ──
    const c = await newJob()
    await t.db.from('jobs').update({
      status: 'in_progress', started_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    }).eq('id', c.id)
    await t.db.from('jobs').update({ started_at: null }).eq('id', c.id)
    const stopped = await readJob(c.id)
    check('⭐ stopping for the day leaves the job IN PROGRESS',
      stopped.status === 'in_progress', `status became ${stopped.status} — stopping finished the job`)
    check('…with the clock cleared', stopped.started_at === null, 'the timer was left running overnight')
    check('…and the time worked banked', (stopped.actual_minutes ?? 0) >= 89 && (stopped.actual_minutes ?? 0) <= 91,
      `expected ~90 banked minutes, got ${stopped.actual_minutes}`)
    const { count: cSessions } = await t.db.from('job_work_sessions')
      .select('id', { count: 'exact', head: true }).eq('job_id', c.id)
    eq('…as exactly one dated session', cSessions, 1)

    // ── Carry forward: no minute is ever lost ──
    // A job as it exists in the book TODAY: a total, and no sessions.
    const d = await newJob({ status: 'completed', actual_minutes: 180, crew_size: 2 })
    eq('a legacy total survives untouched while it has no sessions', (await readJob(d.id)).actual_minutes, 180)
    await addSession(d.id, { minutes: 60, workers: 1, worked_on: '2026-08-16' })
    eq('⭐ its first session CARRIES the old total forward rather than replacing it',
      (await readJob(d.id)).actual_minutes, 240)
    // Sorted here, not by created_at: both rows are written inside one statement
    // and share it to the microsecond, so the database has no order to give.
    const { data: dParts } = await t.db.from('job_work_sessions')
      .select('source, minutes').eq('job_id', d.id)
    eq('…as a session of its own, marked as carried',
      (dParts as { source: string; minutes: number }[]).map(p => `${p.source}:${p.minutes}`).sort(),
      ['carried:180', 'manual:60'])

    // …and by the clock path too.
    const e = await newJob({ actual_minutes: 45 })
    await t.db.from('jobs').update({
      status: 'in_progress', started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    }).eq('id', e.id)
    await t.db.from('jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', e.id)
    const eTotal = (await readJob(e.id)).actual_minutes ?? 0
    check('⭐ a legacy total is carried forward on the clock path as well',
      eTotal >= 74 && eTotal <= 76, `expected ~75 (45 carried + ~30 worked), got ${eTotal}`)

    // ── The tenancy boundary ──
    const { error: fkErr } = await t.db.from('job_work_sessions').insert({
      user_id: t.uid, job_id: randomUUID(), worked_on: '2026-08-14', minutes: 60,
    })
    check('⭐ a session cannot point at a job this business does not own',
      fkErr?.code === '23503',
      `expected a foreign-key violation (23503), got ${fkErr ? `${fkErr.code}: ${fkErr.message}` : 'the insert was ACCEPTED'}`)
    const { error: rlsErr } = await t.db.from('job_work_sessions').insert({
      user_id: randomUUID(), job_id: a.id, worked_on: '2026-08-14', minutes: 60,
    })
    check('⭐ …and cannot be filed under another business either',
      !!rlsErr,
      'a session was written under a user_id that is not the caller — RLS did not hold')

    // ── Bounds ──
    const { error: zeroErr } = await addSession(a.id, { minutes: 0 })
    check('a session recording no time is refused', !!zeroErr, 'a zero-minute session was accepted')
    const { error: weekErr } = await addSession(a.id, { minutes: 20000 })
    check('…and so is one longer than a week', !!weekErr, 'a 14-day single session was accepted')
    const { error: workerErr } = await addSession(a.id, { minutes: 60, workers: 0 })
    check('…and one with nobody on site', !!workerErr, 'a session with zero workers was accepted')
  } finally {
    // The fixture harness sweeps quotes/customers/templates; jobs are this
    // guard's own, so this guard removes them (sessions cascade with them).
    for (const id of jobIds) await t.db.from('jobs').delete().eq('id', id)
    await t.close()
    const residue = await fixtureResidue(t)
    const leftover = Object.entries(residue).filter(([, n]) => n !== 0)
    check('the fixture tenant is left clean',
      leftover.length === 0, `rows left behind: ${JSON.stringify(Object.fromEntries(leftover))}`)
    const { count: strayJobs } = await t.db.from('jobs')
      .select('id', { count: 'exact', head: true }).eq('user_id', t.uid).like('title', `%${t.runId}%`)
    check('…including this run\'s jobs', (strayJobs ?? 0) === 0,
      `${strayJobs} fixture job(s) left behind`)
  }
}

liveChecks()
  .catch(e => { failures++; console.log(`  ✗ the live half threw\n      ${e instanceof Error ? e.message : String(e)}`) })
  .then(() => {
    console.log('')
    if (failures) { console.log(`✗ ${failures} work-session check(s) failed\n`); process.exit(1) }
    console.log('✓ all work-session checks passed — one total, itemised by day; a workday is the business\'s own; and stopping is never finishing\n')
  })
