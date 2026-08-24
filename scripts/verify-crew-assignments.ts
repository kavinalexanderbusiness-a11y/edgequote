// ── verify:crew-assignments ──────────────────────────────────────────────────
//
// THE ONE CLAIM: a visit has exactly one answer to "who is coming" — a crew, a
// person, or nobody — and every surface, RPC and engine agrees on it.
//
// What that breaks down to, and what each part is tested against:
//   · the pure engine (lib/crewAssignment)  → resolution, the chooser, staffing
//   · the database                          → the CHECK that makes two assignees
//                                             unrepresentable, and the crew doors
//   · the source                            → one writer, and no rival predicate
//
// ⭐ The staffing half is where "a crew of 3 must not read as 1 worker" is
// pinned: supply comes from dayFit's own availability rule narrowed to the crew,
// so there is no second capacity engine to drift.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootCrewDb } from './lib/crew-db'
import {
  assigneeOf, assigneeColumns, sameAssignee, assignmentOptions, assigneeValue,
  parseAssigneeValue, expectedWorkers, UNASSIGNED,
} from '../src/lib/crewAssignment'
import type { Crew, Technician } from '../src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const section = (t: string) => console.log(`\n■ ${t}`)

const SRC = (p: string) => readFileSync(join('src', p), 'utf8')
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\r\n]*\/\/[^\r\n]*$/gm, '')

const crew = (id: string, name: string, over: Partial<Crew> = {}): Crew => ({
  id, name, user_id: 'owner', created_at: '', updated_at: '', color: 'emerald',
  day_start: null, day_end: null, capacity_minutes: null, is_active: true, sort_order: 0, ...over,
})
const tech = (id: string, name: string, crewId: string | null, over: Partial<Technician> = {}): Technician => ({
  id, name, user_id: 'owner', created_at: '', updated_at: '', crew_id: crewId, phone: null, email: null,
  role: null, status: 'available', status_changed_at: '', is_active: true, hourly_wage: null,
  hired_on: null, ended_on: null, pto_annual_hours: null, archived_at: null, ...over,
})

async function main() {
console.log('\n══ verify:crew-assignments ════════════════════════════════════════════')

const CREWS = [crew('c1', 'Crew A'), crew('c2', 'Install Crew'), crew('c3', 'Old Crew', { is_active: false })]
const TECHS = [
  tech('t1', 'Jane', 'c1'), tech('t2', 'Peter', 'c1'), tech('t3', 'Sam', null),
  tech('t4', 'Gone', 'c1', { is_active: false, archived_at: '2026-01-01' }),
]

// ── 1. One answer, never two ────────────────────────────────────────────────
section('1. A visit has ONE assignee')
{
  check('a crew visit reads as its crew',
    assigneeOf({ crew_id: 'c1', technician_id: null }).kind === 'crew')
  check('a personal visit reads as that person',
    assigneeOf({ crew_id: null, technician_id: 't1' }).kind === 'person')
  check('neither column set is unassigned',
    assigneeOf({ crew_id: null, technician_id: null }).kind === 'unassigned')

  // ⭐ The write shape is what stops a stale second answer being left behind.
  check('choosing a person CLEARS the crew column',
    assigneeColumns({ kind: 'person', technicianId: 't1' }).crew_id === null)
  check('choosing a crew CLEARS the person column',
    assigneeColumns({ kind: 'crew', crewId: 'c1' }).technician_id === null)
  check('unassigning clears both',
    assigneeColumns(UNASSIGNED).crew_id === null && assigneeColumns(UNASSIGNED).technician_id === null)

  check('a round trip through the chooser value is lossless',
    sameAssignee(parseAssigneeValue(assigneeValue({ kind: 'person', technicianId: 't9' })),
      { kind: 'person', technicianId: 't9' }))
  check('a crew id can never be mistaken for a person id',
    !sameAssignee(parseAssigneeValue('crew:x'), parseAssigneeValue('person:x')))
}

// ── 2. The chooser explains itself ──────────────────────────────────────────
section('2. The chooser cannot read as duplicate values')
{
  const opts = assignmentOptions({ crews: CREWS, technicians: TECHS })
  const values = opts.map(o => o.value)
  check('every option is distinct', new Set(values).size === values.length)
  check('Unassigned is offered first', opts[0].value === 'unassigned')
  check('crews and people are in separate groups',
    opts.some(o => o.group === 'crews') && opts.some(o => o.group === 'people'))

  // THE requirement: Jane appears under people while also being on Crew A, and
  // the hint is what makes the two choices mean different things.
  const jane = opts.find(o => o.label === 'Jane')!
  check('a person on a crew says what picking them ALONE means',
    /alone/i.test(jane.hint ?? ''), jane.hint ?? '(no hint)')
  const crewA = opts.find(o => o.label === 'Crew A')!
  check('a crew says how many people it means',
    /2 people/.test(crewA.hint ?? ''), crewA.hint ?? '(no hint)')
  check('an empty crew says so rather than claiming staff',
    /Nobody/i.test(assignmentOptions({ crews: [crew('c9', 'Empty')], technicians: [] })
      .find(o => o.label === 'Empty')?.hint ?? ''))

  check('a deactivated crew is not offered for new work',
    !opts.some(o => o.label === 'Old Crew'))
  check('…but IS shown while it still holds this visit',
    assignmentOptions({ crews: CREWS, technicians: TECHS, current: { kind: 'crew', crewId: 'c3' } })
      .some(o => o.label === 'Old Crew' && o.disabled))
  check('somebody off the roster is not offered either',
    !opts.some(o => o.label === 'Gone'))
  check('Unassigned explains its consequence',
    /phone/i.test(opts[0].hint ?? ''), opts[0].hint ?? '')
}

// ── 3. Resolution is honest about what it does not know ─────────────────────
section('3. Who is expected — and when that is unknown')
{
  const ctx = { crews: CREWS, technicians: TECHS }
  const r = expectedWorkers({ crew_id: 'c1', technician_id: null }, ctx)
  check('a crew resolves to its CURRENT active members',
    r.expectedCount === 2 && r.expected.map(t => t.name).join(',') === 'Jane,Peter',
    `${r.expectedCount}: ${r.expected.map(t => t.name).join(',')}`)
  check('an archived member is not counted as expected',
    !r.expected.some(t => t.name === 'Gone'))

  const p = expectedWorkers({ crew_id: null, technician_id: 't3' }, ctx)
  check('a person resolves to exactly themselves', p.expectedCount === 1 && p.label === 'Sam')

  // ⭐⭐ unknown ≠ zero, the rule the whole codebase runs on.
  const unknown = expectedWorkers({ crew_id: 'c1', technician_id: null }, { ...ctx, rosterKnown: false })
  check('an unreadable roster claims NOTHING (null, never 0)',
    unknown.expectedCount === null && unknown.issue === null, JSON.stringify(unknown.expectedCount))

  check('a crew with nobody on it is reported as a problem',
    expectedWorkers({ crew_id: 'c9', technician_id: null },
      { crews: [crew('c9', 'Empty')], technicians: [] }).issue === 'crew_empty')
  check('a deactivated crew holding work is reported',
    expectedWorkers({ crew_id: 'c3', technician_id: null }, ctx).issue === 'crew_inactive')
  check('a departed person holding work is reported',
    expectedWorkers({ crew_id: null, technician_id: 't4' }, ctx).issue === 'person_off_roster')
  check('a crew id that no longer exists is reported, not rendered blank',
    expectedWorkers({ crew_id: 'gone', technician_id: null }, ctx).issue === 'crew_unknown')
}

// ── 4. ONE staffing engine, and it is not this one ──────────────────────────
// Session 67 landed per-crew staffing warnings inside lib/dayPlan, built on
// per-worker availability states. Session 65 briefly grew a second answer from
// crew membership + PTO rows; it was DELETED rather than merged. This section
// exists so it cannot quietly come back.
section('4. Capacity resolves the actual assigned workforce — in ONE place')
{
  const engine = stripComments(SRC('lib/crewAssignment.ts'))
  const plan = stripComments(SRC('lib/dayPlan.ts'))

  check('the assignment engine raises no day-staffing warnings of its own',
    !/staffingWarnings|StaffingWarning|assignmentStaffing/.test(engine),
    'a second engine answering "is this day staffed?" has come back')
  check('…and defines no capacity or availability arithmetic',
    !/capacityHours|daily_capacity|FIT_BUFFER|workersAvailableOn/.test(engine))

  // dayPlan owns it, and knows about BOTH kinds of assignment.
  check('lib/dayPlan owns the crew shortfall warning',
    /crew_understaffed/.test(plan) && /crewsWithWork/.test(plan))
  check('…and judges a personally-assigned visit against THAT person',
    /technicianId/.test(plan) && /personalIds/.test(plan),
    'a visit given to one person by name must not be covered by their crewmates')
  check('a personal shortfall blocks rather than warns',
    /personalIds[\s\S]{0,700}severity: 'blocking'/.test(plan))
  check('the stop input carries both assignment columns',
    /crewId\?: string \| null/.test(plan) && /technicianId\?: string \| null/.test(plan))

  // ⭐ THE regression this section replaces: a crew of N must not read as 1.
  // dayFit's supply rule, narrowed to a crew, is what guarantees it.
  const fit = stripComments(SRC('lib/dayFit.ts'))
  // The narrowing lives as a KEY on the shared options object, which is how
  // this function was designed to grow — never as a second counter.
  check('availability can be asked per crew, from the ONE rule',
    /interface WorkersAvailableOpts[\s\S]{0,400}crewId\?: string/.test(fit) &&
    /t\.crew_id === opts\.crewId/.test(fit),
    'crewId must be a key on WorkersAvailableOpts, not a rival availability counter')
  check('…and the solo-owner fallback does NOT apply to a crew',
    /if \(opts\?\.crewId != null\)[\s\S]{0,220}\n  if \(roster\.length === 0\) return 1/.test(fit),
    'an empty crew must count 0, not be rounded up to the solo owner')
  check('approved leave and weekly patterns apply to the crew view too',
    /const free = \(t: TechForAvailability\)[\s\S]{0,240}crew_id === opts\.crewId && free\(t\)/.test(fit),
    'the crew branch must reuse the same free() predicate, not a bare PTO check')
}

// ── 5. One writer, one predicate ────────────────────────────────────────────
section('5. No rival assignment path')
{
  const crews = stripComments(SRC('lib/crews.ts'))
  check('assignJob is THE writer and writes both columns',
    /export async function assignJob\b[\s\S]{0,400}assigneeColumns\(assignee\)/.test(crews))
  check('the crew-only helper delegates rather than updating separately',
    /export async function assignJobCrew[\s\S]{0,300}return assignJob\(/.test(crews))

  // Any OTHER file writing the assignment columns directly would be a second
  // path. The dispatch board's own undo/restore is allowed to (it replays a
  // snapshot), so this asserts the shape rather than banning the string.
  const migration = readFileSync(
    join('supabase', 'archive', 'ledger', '20260816043000_crews_team_assignments_v1.sql'), 'utf8')
  check('the database makes two assignees unrepresentable',
    /constraint jobs_one_assignee\s*\n?\s*check \(crew_id is null or technician_id is null\)/i.test(migration))
  check('one shared predicate answers "may this worker see this visit"',
    /create or replace function public\.crew_assignment_covers/i.test(migration))

  // Every crew door must use it — a door with its own predicate is a second
  // assignment model, and the one most likely to leak.
  const doors = ['crew_day', 'crew_upcoming', 'crew_set_visit_status', 'crew_set_completion_record',
    'crew_job_messages', 'crew_message_inbox', 'crew_post_message']
  const missing = doors.filter(d => {
    const body = migration.split(new RegExp(`FUNCTION public\\.${d}\\b`))[1]?.split('$function$')[1] ?? ''
    return !/crew_assignment_covers/.test(body)
  })
  check('every crew door resolves assignment through it',
    missing.length === 0, missing.join(', '))

  check('a crew session still cannot reassign a visit',
    /crew_job_field_guard[\s\S]*?new\.technician_id[\s\S]*?old\.technician_id/.test(migration))
}

// ── 6. The database, attacked ───────────────────────────────────────────────
section('6. Attacking the real schema')
const boot = await bootCrewDb()
if ('skipped' in boot) {
  console.log(`  ⏭  database half SKIPPED — ${boot.skipped}`)
} else {
  const db = boot
  const { ids } = db

  check('a visit cannot carry a crew AND a person',
    (await db.expectRefusal(
      `update public.jobs set technician_id = '${ids.techA1}' where id = '${ids.jobA}'`)) != null,
    'both assignment columns were accepted at once')

  // Swapping IS allowed — it is one answer replacing another.
  await db.exec(`update public.jobs set crew_id = null, technician_id = '${ids.techA1}' where id = '${ids.jobA}'`)
  const row = await db.query(`select crew_id, technician_id from public.jobs where id = '${ids.jobA}'`)
  check('reassigning from a crew to a person leaves exactly one answer',
    row.rows[0].crew_id === null && row.rows[0].technician_id === ids.techA1)

  check('a forged person id is refused',
    (await db.expectRefusal(
      `update public.jobs set technician_id = '00000000-0000-0000-0000-0000000000ee' where id = '${ids.jobA}'`)) != null)

  // The visibility predicate itself, exercised as the doors call it.
  const covers = await db.query(`
    select
      public.crew_assignment_covers('${ids.crewA1}', null, '${ids.crewA1}', '${ids.techA1}') as my_crew,
      public.crew_assignment_covers(null, '${ids.techA1}', '${ids.crewA1}', '${ids.techA1}') as mine,
      public.crew_assignment_covers('${ids.crewA2}', null, '${ids.crewA1}', '${ids.techA1}') as other_crew,
      public.crew_assignment_covers(null, '${ids.techA2}', '${ids.crewA1}', '${ids.techA1}') as someone_else,
      public.crew_assignment_covers(null, null, '${ids.crewA1}', '${ids.techA1}') as unassigned,
      public.crew_assignment_covers(null, null, null, '${ids.techA1}') as no_crew_unassigned,
      public.crew_assignment_covers('${ids.crewA1}', null, null, '${ids.techA1}') as crewless_worker`)
  const c = covers.rows[0]
  check('my crew\'s work is visible to me', c.my_crew === true)
  check('work assigned to me by name is visible to me', c.mine === true)
  check('another crew\'s work is not', c.other_crew === false)
  check('another person\'s work is not', c.someone_else === false)
  check('unassigned work reaches nobody', c.unassigned === false)
  check('a worker on no crew still sees nothing unassigned', c.no_crew_unassigned === false)
  // ⭐ The NULL trap: `j.crew_id = v_crew` with v_crew NULL is NULL, not false —
  // which is why the predicate is explicit rather than a bare equality.
  check('a crewless worker does not inherit a crew\'s work', c.crewless_worker === false)

  await db.close()
}

console.log(`\n${'─'.repeat(70)}`)
if (fail === 0) console.log(`CREW ASSIGNMENTS VERIFIED — ${pass} checks passed.\n`)
else console.error(`CREW ASSIGNMENTS: ${fail} FAILED, ${pass} passed.\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
