// ── Verify: estimate appointments, and everything they must NOT become ───────
//   npm run verify:estimate-appointments
//
// WHY THIS SCRIPT EXISTS
//
// Before Session 79 the owner held an estimate slot with a $0 quote and a $0
// job. Because the slot was a `jobs` row, every engine that reads jobs fired
// against it: job completion, the customer "your service is complete" message,
// proof-of-work, invoicing, revenue, recurrence satisfaction, review-request
// eligibility. The fix is that an estimate visit is a row in `schedule_items`
// instead — a different table that none of those engines read.
//
// That makes the boundary STRUCTURAL, and structural boundaries are exactly the
// kind that erode quietly: nothing in tsc or `next build` can see the day
// somebody adds a trigger, a cron or a convenience helper that reaches across.
// So this guard asserts the negative directly, against the real database:
// completing an estimate visit changes the jobs / invoices / notifications /
// work-session counts by ZERO.
//
// ⭐ EVERY CHECK HERE CAN FAIL. Assertions that cannot fail are the thing this
// codebase has been burned by before, so the text scans carry NEGATIVE CONTROLS
// — the same matcher is run against a synthetic violation and must catch it. A
// scan that reports "clean" on a string designed to break it is reported as a
// broken guard, not as a pass.
//
// ⭐ EVERY LIVE WRITE GOES THROUGH THE FIXTURE TENANT (scripts/lib/verify-fixture).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ESTIMATE_MIN, ESTIMATE_STATUSES, STATUS_LABELS, TERMINAL_STATUSES,
  awaitingQuote, canTransition, estimateMinutes, isOpen, isTerminal,
  newEstimateDraft, statusPatch, timeLabel, toDayVisit, toRouteStop,
  validateEstimate, type EstimateAppointment,
} from '../src/lib/estimateAppointments'
import { DEFAULT_TEMPLATES, MSG_LABELS, msgCategory, type MsgType } from '../src/lib/comms/templates'
import { dayCommitment } from '../src/lib/dayFit'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const src = (p: string) => readFileSync(p, 'utf8')

/** Comments explain the rules, so a raw scan finds the forbidden word in the
 *  prose forbidding it. Strip comments before asserting over code. LINE comments
 *  go first: a `//` inside a block comment would otherwise survive. */
function stripComments(s: string): string {
  return s
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The one migration this session added. */
function estimateMigration(): string {
  const dir = 'supabase/migrations'
  const f = readdirSync(dir).find(n => n.includes('estimate_appointments'))
  return f ? readFileSync(join(dir, f), 'utf8') : ''
}

console.log('\n── Estimate appointments ──────────────────────────────────────────\n')

// ═══════════════════════════════════════════════════════════════════════════
// 1 · The lifecycle is four states, and completing is not finishing
// ═══════════════════════════════════════════════════════════════════════════
console.log('  Lifecycle')

eq('four statuses, no more', ESTIMATE_STATUSES.length, 4)
check('no_show is one of them — a wasted trip is not a cancellation',
  ESTIMATE_STATUSES.includes('no_show') && ESTIMATE_STATUSES.includes('cancelled'),
  `got ${ESTIMATE_STATUSES.join(', ')}`)
eq('three of them are terminal', TERMINAL_STATUSES.length, 3)
check('only `scheduled` is open', isOpen({ status: 'scheduled' }) && !isOpen({ status: 'completed' }))
check('completed / cancelled / no_show are all terminal',
  isTerminal('completed') && isTerminal('cancelled') && isTerminal('no_show') && !isTerminal('scheduled'))

// The label is the contract. This is the exact surface where the $0-job
// workaround used to tell a customer their work was finished.
check('the completed label never says the JOB is done',
  !/job|service|work/i.test(STATUS_LABELS.completed),
  `STATUS_LABELS.completed = "${STATUS_LABELS.completed}" — it must describe the VISIT, not the work`)

check('an open visit may be completed, cancelled or no-showed',
  canTransition('scheduled', 'completed') && canTransition('scheduled', 'cancelled') && canTransition('scheduled', 'no_show'))
check('a terminal visit may only be reopened',
  canTransition('cancelled', 'scheduled') && !canTransition('cancelled', 'no_show') && !canTransition('completed', 'cancelled'),
  'terminal → terminal must be refused so a correction is a visible reopen')
check('a status cannot transition to itself', !canTransition('scheduled', 'scheduled'))

// statusPatch is the only writer of completed_at.
eq('completing stamps completed_at only', statusPatch('completed').completed_at !== null, true)
eq('cancelling does not stamp completed_at', statusPatch('cancelled').completed_at, null)
eq('a no-show does not stamp completed_at', statusPatch('no_show').completed_at, null)
eq('reopening clears completed_at', statusPatch('scheduled').completed_at, null)
eq('a cancel keeps its reason', statusPatch('cancelled', ' rain ').cancel_reason, 'rain')
eq('completing carries no cancel reason', statusPatch('completed', 'rain').cancel_reason, null)
eq('reopening clears the reason', statusPatch('scheduled', 'rain').cancel_reason, null)

// ═══════════════════════════════════════════════════════════════════════════
// 2 · What the form may not send
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  Input rules')

const goodDraft = newEstimateDraft({ dateISO: '2026-09-01', customerName: 'Smith', customerId: 'c1' })
eq('a new draft is valid', validateEstimate(goodDraft), null)
eq('a new draft defaults to 30 minutes', goodDraft.duration_minutes, DEFAULT_ESTIMATE_MIN)
eq('a new draft is named after the customer', goodDraft.title, 'Estimate — Smith')
check('an untitled visit is refused', validateEstimate({ ...goodDraft, title: '  ' }) !== null)
check('a dateless visit is refused', validateEstimate({ ...goodDraft, scheduled_date: '' }) !== null)
check('a nonsense date is refused', validateEstimate({ ...goodDraft, scheduled_date: 'tomorrow' }) !== null)
check('zero minutes is refused', validateEstimate({ ...goodDraft, duration_minutes: 0 }) !== null)
check('a negative duration is refused', validateEstimate({ ...goodDraft, duration_minutes: -30 }) !== null)
check('longer than a working day is refused', validateEstimate({ ...goodDraft, duration_minutes: 13 * 60 }) !== null)
check('a crew AND a person is refused — the same rule the DB enforces',
  validateEstimate({ ...goodDraft, crew_id: 'x', technician_id: 'y' }) !== null)
eq('a crew alone is fine', validateEstimate({ ...goodDraft, crew_id: 'x' }), null)
eq('a person alone is fine', validateEstimate({ ...goodDraft, technician_id: 'y' }), null)

// ═══════════════════════════════════════════════════════════════════════════
// 3 · It consumes TIME (and nothing else)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  Day capacity')

const appt = (over: Partial<EstimateAppointment> = {}): EstimateAppointment => ({
  id: 'e1', type: 'estimate', title: 'Estimate — Smith', customer_id: 'c1', property_id: 'p1',
  scheduled_date: '2026-09-01', start_time: '10:30:00', duration_minutes: 45,
  notes: null, customer_note: null, cancel_reason: null, phone: null, due_at: null,
  status: 'scheduled', converted_quote_id: null, completed_at: null, updated_at: null,
  crew_id: null, technician_id: null,
  properties: { id: 'p1', address: '1 Test St', lat: 51, lng: -114 },
  ...over,
}) as EstimateAppointment

eq('a stated duration is used', estimateMinutes(appt()), 45)
eq('an unstated duration falls to the default', estimateMinutes(appt({ duration_minutes: null })), DEFAULT_ESTIMATE_MIN)
eq('the day adapter states no crew size — nobody typed one',
  toDayVisit(appt()).crew_size, undefined)
eq('the day adapter carries no service type — an estimate is not a service',
  toDayVisit(appt()).service_type, null)

// The adapter must actually move the ONE capacity engine's numbers.
const capIn = { capacityHours: 8, workers: 1 }
const withoutEstimate = dayCommitment({ visits: [{ duration_minutes: 60, status: 'scheduled' }], ...capIn })
const withEstimate = dayCommitment({ visits: [{ duration_minutes: 60, status: 'scheduled' }, toDayVisit(appt())], ...capIn })
check('an estimate visit reduces the day\'s spare time',
  withEstimate.spareClockMin < withoutEstimate.spareClockMin,
  `spare went ${withoutEstimate.spareClockMin} → ${withEstimate.spareClockMin}; an estimate must occupy the day`)
eq('…and adds a stop', withEstimate.stops, withoutEstimate.stops + 1)

const cancelledDay = dayCommitment({ visits: [toDayVisit(appt({ status: 'cancelled' }))], ...capIn })
eq('a cancelled estimate occupies nothing', cancelledDay.stops, 0)

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Routing reuses the one route engine
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  Routing')

const stop = toRouteStop(appt())
check('a located, open estimate is a route stop', stop !== null)
eq('…carrying its own id', stop?.jobId, 'e1')
eq('…and its address', stop?.address, '1 Test St')
check('an unlocated estimate is not a stop',
  toRouteStop(appt({ properties: { id: 'p1', address: '1 Test St', lat: null, lng: null } })) === null,
  'an address we cannot place cannot be sequenced')
check('a cancelled estimate is not a stop', toRouteStop(appt({ status: 'cancelled' })) === null)
check('a completed estimate is not a stop', toRouteStop(appt({ status: 'completed' })) === null,
  'you do not drive to a visit you have already made')

// ═══════════════════════════════════════════════════════════════════════════
// 5 · The words. Nothing may imply the work happened.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  Customer communication')

const APPT_TYPES: MsgType[] = ['estimate_appt_scheduled', 'estimate_appt_on_my_way', 'estimate_appt_rescheduled']
for (const t of APPT_TYPES) {
  check(`${t} exists and is labelled`, Boolean(MSG_LABELS[t]), 'a template with no label cannot be edited by the owner')
  check(`${t} has default wording`, Boolean(DEFAULT_TEMPLATES[t]))
}

// The reason these are their own types at all.
check('estimate messages are NOT the job templates',
  DEFAULT_TEMPLATES.estimate_appt_on_my_way !== DEFAULT_TEMPLATES.on_my_way
  && DEFAULT_TEMPLATES.estimate_appt_rescheduled !== DEFAULT_TEMPLATES.rescheduled,
  'reusing the job wording is exactly what this feature exists to stop')

// A visit that has not happened cannot be described as finished, and a price has
// not been agreed, so no estimate message may talk like a completed service.
const COMPLETION_WORDS = /\b(complete[d]?|finished|all done|your service is|thanks for your business|invoice|amount due|balance)\b/i
for (const t of APPT_TYPES) {
  check(`${t} never claims the work is done or owed`,
    !COMPLETION_WORDS.test(DEFAULT_TEMPLATES[t]),
    `"${DEFAULT_TEMPLATES[t].slice(0, 90)}…" matched ${COMPLETION_WORDS}`)
}
// NEGATIVE CONTROL — the matcher above must actually catch the thing it guards.
check('…and that matcher would catch a violation (negative control)',
  COMPLETION_WORDS.test('Hi, we have finished up — thanks for your business!'),
  'the completion-language matcher is vacuous; it cannot fail, so it proves nothing')

check('there is deliberately no estimate analogue of job_complete',
  !Object.keys(MSG_LABELS).some(k => /^estimate_appt.*(complete|done|finish)/i.test(k)),
  'an estimate visit ending is not a service completion and must have no template that says so')

for (const t of APPT_TYPES) {
  eq(`${t} rides the appointment preference, not the quote one`, msgCategory(t), 'reminders')
}
check('the quote itself still rides the estimates preference', msgCategory('quote') === 'estimates',
  'the message that follows the visit is a solicitation and must stay opt-out-able')

// ═══════════════════════════════════════════════════════════════════════════
// 6 · Reading one back
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  Presentation')

eq('a timed visit reads as time · length', timeLabel(appt()), '10:30 am · 45 min')
eq('an untimed visit reads as a length only', timeLabel(appt({ start_time: null })), '45 min')
check('a completed visit with no quote is what the owner still owes',
  awaitingQuote(appt({ status: 'completed' })) && !awaitingQuote(appt({ status: 'completed', converted_quote_id: 'q1' })),
  'the point of the visit is the quote; "done, nothing written" is the state worth chasing')
check('an open visit is not yet awaiting a quote', !awaitingQuote(appt()))

// ═══════════════════════════════════════════════════════════════════════════
// 7 · The boundary, in the source
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  The boundary (static)')

const migration = estimateMigration()
check('the migration exists', migration.length > 0, 'no supabase/migrations/*estimate_appointments*.sql')
for (const needed of ['schedule_items_type_check', 'schedule_items_status_check', 'schedule_items_one_assignee_check']) {
  check(`the DB constrains it: ${needed}`, migration.includes(needed),
    'app-level validation is a courtesy; the constraint is the enforcement')
}
check('the update policy gained its tenant weld',
  /for update[\s\S]{0,200}with check/i.test(migration),
  'USING without WITH CHECK lets a tenant hand a row to another user_id')
check('no trigger in the migration writes to another table',
  !/create\s+trigger[\s\S]*?execute\s+function\s+(?!public\.set_updated_at)/i.test(
    stripComments(migration).replace(/create trigger trg_schedule_items_updated[\s\S]*?set_updated_at\(\);/i, '')),
  'a trigger reaching out of schedule_items is how the boundary would erode')

// The estimate code path must never write the tables the boundary protects.
const ESTIMATE_SOURCES = [
  'src/lib/estimateAppointments.ts',
  'src/hooks/useEstimateAppointments.ts',
  'src/components/schedule/EstimateDayBoard.tsx',
  'src/components/schedule/EstimateAppointmentDialog.tsx',
]
const FORBIDDEN_WRITE = /\.from\(\s*['"](jobs|invoices|job_work_sessions|job_line_items|notifications|payments)['"]\s*\)/
for (const f of ESTIMATE_SOURCES) {
  const code = stripComments(src(f))
  check(`${f.split('/').pop()} never writes a job/invoice/session/payment table`,
    !FORBIDDEN_WRITE.test(code),
    `matched ${FORBIDDEN_WRITE} — an estimate path must not reach the work engines`)
}
// NEGATIVE CONTROL — prove the scan can fail.
check('…and that scan would catch a violation (negative control)',
  FORBIDDEN_WRITE.test(`await supabase.from('jobs').insert({})`),
  'the forbidden-write matcher is vacuous')
// …and prove stripComments is not eating the code it scans.
check('the comment stripper keeps code and drops prose',
  stripComments('// from("jobs")\nconst a = 1 // x\n/* from("jobs") */').includes('const a = 1')
  && !stripComments('// from("jobs")\nconst a = 1').includes('from("jobs")'),
  'if the stripper ate everything, every scan above would pass vacuously')

// ═══════════════════════════════════════════════════════════════════════════
// 8 · The boundary, against the real database
// ═══════════════════════════════════════════════════════════════════════════
async function liveChecks() {
  console.log('\n  The boundary (live)')
  const t = await openFixtureTenant('verify:estimate-appointments')
  if (isSkipped(t)) { console.log(`  ⊘ live half skipped — ${t.skipped}`); return }

  const made: string[] = []
  try {
    const customer = await t.fixtureCustomer()

    // ── Counting what must not move ──────────────────────────────────────────
    const countOf = async (table: string) => {
      const { count, error } = await t.db.from(table).select('id', { count: 'exact', head: true }).eq('user_id', t.uid)
      // A failed count is NOT a zero — it would make every boundary check below
      // pass by accident, which is worse than failing.
      if (error) { fail(`counting ${table}`, error.message); return -1 }
      return count ?? -1
    }
    const before = {
      jobs: await countOf('jobs'),
      invoices: await countOf('invoices'),
      notifications: await countOf('notifications'),
      sessions: await countOf('job_work_sessions'),
      messages: await countOf('messages'),
    }
    check('the fixture tenant\'s counts are readable', Object.values(before).every(n => n >= 0),
      `got ${JSON.stringify(before)} — a boundary proven against unreadable counts proves nothing`)

    // ── Schedule one ─────────────────────────────────────────────────────────
    const title = t.tag('ESTIMATE')
    const { data: created, error: createErr } = await t.db.from('schedule_items').insert({
      user_id: t.uid, type: 'estimate', title, customer_id: customer.id,
      scheduled_date: '2026-09-01', start_time: '10:30', duration_minutes: 45,
      notes: 'internal only', customer_note: 'I will walk the back yard with you',
    }).select('id, status, type, completed_at').single()
    check('an estimate visit can be scheduled', !createErr && !!created, createErr?.message ?? 'no row')
    if (!created) return
    made.push(created.id)
    eq('…and starts scheduled', created.status, 'scheduled')
    eq('…with nothing completed', created.completed_at, null)

    // ── The constraints actually refuse bad rows (DB-level mutation tests) ────
    const { error: badType } = await t.db.from('schedule_items').insert({
      user_id: t.uid, type: 'not_a_type', title: t.tag('BADTYPE'), scheduled_date: '2026-09-01',
    })
    check('an invented type is refused by the database', !!badType, 'schedule_items_type_check did not hold')

    const { error: badStatus } = await t.db.from('schedule_items').update({ status: 'invoiced' }).eq('id', created.id)
    check('an invented status is refused by the database', !!badStatus, 'schedule_items_status_check did not hold')

    const { error: bothAssignees } = await t.db.from('schedule_items').insert({
      user_id: t.uid, type: 'estimate', title: t.tag('BOTH'), scheduled_date: '2026-09-01',
      crew_id: '00000000-0000-0000-0000-000000000001', technician_id: '00000000-0000-0000-0000-000000000002',
    })
    check('a crew AND a person is refused by the database', !!bothAssignees,
      'schedule_items_one_assignee_check did not hold')

    // ── Tenant isolation ─────────────────────────────────────────────────────
    const { data: foreign } = await t.anon.from('schedule_items').select('id').eq('id', created.id)
    eq('an anonymous caller cannot read it', foreign?.length ?? 0, 0)
    const { error: stealErr, data: stolen } = await t.db.from('schedule_items')
      .update({ user_id: '00000000-0000-0000-0000-0000000000ff' }).eq('id', created.id).select('id')
    check('the row cannot be handed to another tenant',
      !!stealErr || (stolen?.length ?? 0) === 0,
      'WITH CHECK on the update policy is missing — a row could be moved across the boundary')

    // ── Reschedule ───────────────────────────────────────────────────────────
    const { error: moveErr } = await t.db.from('schedule_items')
      .update({ scheduled_date: '2026-09-03', start_time: '14:00' }).eq('id', created.id)
    check('it can be rescheduled', !moveErr, moveErr?.message ?? '')
    const { data: moved } = await t.db.from('schedule_items')
      .select('scheduled_date, updated_at').eq('id', created.id).single()
    eq('…to the new day', moved?.scheduled_date, '2026-09-03')
    check('…and the move is stamped', !!moved?.updated_at, 'updated_at trigger did not fire')

    // ── ⭐ COMPLETING IT CHANGES NOTHING ELSE ────────────────────────────────
    const { error: doneErr } = await t.db.from('schedule_items')
      .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', created.id)
    check('the visit can be marked done', !doneErr, doneErr?.message ?? '')

    const after = {
      jobs: await countOf('jobs'),
      invoices: await countOf('invoices'),
      notifications: await countOf('notifications'),
      sessions: await countOf('job_work_sessions'),
      messages: await countOf('messages'),
    }
    eq('⛔ completing an estimate creates NO job', after.jobs, before.jobs)
    eq('⛔ …mints NO invoice', after.invoices, before.invoices)
    eq('⛔ …raises NO notification', after.notifications, before.notifications)
    eq('⛔ …opens NO work session', after.sessions, before.sessions)
    eq('⛔ …sends NO message', after.messages, before.messages)

    // The row itself is the only thing that moved.
    const { data: doneRow } = await t.db.from('schedule_items')
      .select('status, completed_at, type').eq('id', created.id).single()
    eq('the visit is completed', doneRow?.status, 'completed')
    check('…and is still an estimate, not a job', doneRow?.type === 'estimate')

    // ── Cancel / no-show / reopen ────────────────────────────────────────────
    const { data: second } = await t.db.from('schedule_items').insert({
      user_id: t.uid, type: 'estimate', title: t.tag('ESTIMATE2'), customer_id: customer.id,
      scheduled_date: '2026-09-04',
    }).select('id').single()
    if (second) {
      made.push(second.id)
      const { error: nsErr } = await t.db.from('schedule_items')
        .update({ status: 'no_show', cancel_reason: 'nobody home' }).eq('id', second.id)
      check('a no-show is recordable', !nsErr, nsErr?.message ?? '')
      const { data: ns } = await t.db.from('schedule_items')
        .select('status, cancel_reason, completed_at').eq('id', second.id).single()
      eq('…as its own status', ns?.status, 'no_show')
      eq('…with its reason kept', ns?.cancel_reason, 'nobody home')
      eq('…and never stamped complete', ns?.completed_at, null)

      const { error: reopenErr } = await t.db.from('schedule_items')
        .update({ status: 'scheduled', cancel_reason: null }).eq('id', second.id)
      check('it can be put back on the schedule', !reopenErr, reopenErr?.message ?? '')
    }

    // ── The quote link, both directions ──────────────────────────────────────
    const template = await t.fixtureTemplate()
    const { data: quote } = await t.db.from('quotes').insert({
      user_id: t.uid, quote_number: t.tag('Q'), customer_name: 'Fixture', address: '1 Verification Way',
      service_type: template.name, customer_id: customer.id, initial_price: 100,
    }).select('id').single()
    if (quote) {
      const { error: linkErr } = await t.db.from('schedule_items')
        .update({ converted_quote_id: quote.id }).eq('id', created.id)
      check('the visit can point at the quote it produced', !linkErr, linkErr?.message ?? '')
      const { data: linked } = await t.db.from('schedule_items')
        .select('converted_quote_id').eq('id', created.id).single()
      eq('…and the link reads back', linked?.converted_quote_id, quote.id)

      // Deleting the quote must not delete the history of the visit.
      await t.db.from('quotes').delete().eq('id', quote.id)
      const { data: survived } = await t.db.from('schedule_items')
        .select('id, converted_quote_id').eq('id', created.id).maybeSingle()
      check('deleting the quote leaves the visit standing', !!survived,
        'the FK is ON DELETE SET NULL — a deleted quote must not erase the visit that happened')
      eq('…with the link cleared', survived?.converted_quote_id, null)
    }
  } finally {
    for (const id of made) await t.db.from('schedule_items').delete().eq('id', id)
    await t.close()
    const residue = await fixtureResidue(t)
    const leftover = Object.entries(residue).filter(([, n]) => n !== 0)
    check('the fixture tenant is left clean', leftover.length === 0,
      `rows left behind: ${JSON.stringify(Object.fromEntries(leftover))}`)
    const { count: stray } = await t.db.from('schedule_items')
      .select('id', { count: 'exact', head: true }).eq('user_id', t.uid).like('title', `%${t.runId}%`)
    check('…including this run\'s estimate visits', (stray ?? 0) === 0, `${stray} left behind`)
  }
}

liveChecks()
  .catch(e => { failures++; console.log(`  ✗ the live half threw\n      ${e instanceof Error ? e.message : String(e)}`) })
  .then(() => {
    console.log('')
    if (failures) { console.log(`✗ ${failures} estimate-appointment check(s) failed\n`); process.exit(1) }
    console.log('✓ all estimate-appointment checks passed — a visit to price the work, which occupies the day, and completing it finishes nothing\n')
  })
