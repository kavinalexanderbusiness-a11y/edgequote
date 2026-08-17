// ── verify:worker-access ─────────────────────────────────────────────────────
//
// THE ONE CLAIM: a worker reaches exactly the work assigned to them — by crew or
// by name — and nothing else in the business, and every door asks that question
// the SAME way, on the server.
//
// What that breaks down to, and what each part is tested against:
//   · the predicate (lib/workerAccess)  → pure, including the null cases that
//                                          would hand out the whole tenant
//   · the database (PGlite, real SQL)   → the attacks: another tenant, another
//                                          crew, another person, unassigned,
//                                          forged ids, a disabled account,
//                                          self-promotion, office-only states
//   · the source                        → every worker door calls the canonical
//                                          layer, and none keeps a rival copy
//
// ⭐ WHY A REAL DATABASE. Everything that actually stops a worker is enforced in
// SQL — DEFINER functions that re-derive identity from the session, a trigger
// that refuses every job column except status, RLS that scopes each table to its
// owner. A guard that greps the migration proves the text was written. Applying
// it to Postgres and TRYING THE ATTACK is what proves it holds. If PGlite is
// absent the database half SKIPS clean and the engine + source halves still run.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootCrewDb } from './lib/crew-db'
import {
  workerCoversVisit, assignedVisitFilter, workerMayTransition, isWorkerVisitStatus,
  WORKER_VISIT_STATUSES, WORKER_DENIAL_STATUS, WORKER_DENIAL_MESSAGE, isUuid,
  resolveWorker, authorizeWorkerVisit,
} from '../src/lib/workerAccess'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const section = (t: string) => console.log(`\n■ ${t}`)

const SRC = (p: string) => readFileSync(join('src', p), 'utf8')
// ⚠️ LINE comments first, then block comments. A line comment mentioning a glob
// like app/api/** opens a /* that the block regex then closes far below,
// swallowing real code. That cost two false failures in Session 64.
const strip = (s: string) =>
  s.replace(/^[^\S\r\n]*\/\/[^\r\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const MIGRATIONS = join('supabase', 'migrations')
const allSql = () =>
  readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    .map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')

/** The worker doors. Every one of these must go through lib/workerAccess. */
const WORKER_ROUTES = [
  'app/api/crew/complete/route.ts',
  'app/api/crew/media/route.ts',
  'app/api/crew/photos/route.ts',
]

const W = (technicianId: string, crewId: string | null) => ({ technicianId, crewId })
const V = (crewId: string | null, technicianId: string | null) => ({ crewId, technicianId })

async function main() {
console.log('\n══ verify:worker-access ═══════════════════════════════════════════════')

// ── 1. The predicate, including the nulls that give away the business ────────
section('1. Coverage: crew OR by name, and never by accident')
{
  check('a crew visit is covered for a member of that crew',
    workerCoversVisit(W('t1', 'c1'), V('c1', null)))
  check('a by-name visit is covered for that person',
    workerCoversVisit(W('t1', null), V(null, 't1')))
  check('a by-name visit is covered even when the person also has a crew',
    workerCoversVisit(W('t1', 'c1'), V(null, 't1')))

  check('another crew’s visit is NOT covered',
    !workerCoversVisit(W('t1', 'c1'), V('c2', null)))
  check('another person’s visit is NOT covered',
    !workerCoversVisit(W('t1', 'c1'), V(null, 't2')))
  check('an unassigned visit is NOT covered',
    !workerCoversVisit(W('t1', 'c1'), V(null, null)))

  // ⚠️⚠️ THE ONE THAT WOULD HAND OVER THE WHOLE TENANT. A crewless worker and an
  // unassigned visit both carry null. Compared naively they are equal, and every
  // unassigned visit in the business becomes "assigned to me".
  check('⚠️ a CREWLESS worker does NOT match an UNASSIGNED visit (null ≠ null)',
    !workerCoversVisit(W('t1', null), V(null, null)))
  check('⚠️ a crewless worker does not match another crewless worker’s visit',
    !workerCoversVisit(W('t1', null), V(null, 't2')))
  check('⚠️ a worker with a crew does not match a visit whose crew is null',
    !workerCoversVisit(W('t1', 'c1'), V(null, null)))
}

// ── 2. The set-level spelling agrees with the single-visit one ──────────────
section('2. The PostgREST filter says the same thing')
{
  const withCrew = assignedVisitFilter(W('t1', 'c1'))
  check('a crewed worker filters on BOTH crew and name',
    withCrew === 'crew_id.eq.c1,technician_id.eq.t1', withCrew)

  const crewless = assignedVisitFilter(W('t1', null))
  check('a crewless worker filters on name ONLY',
    crewless === 'technician_id.eq.t1', crewless)
  // The spelling that would match every unassigned visit in the tenant.
  check('⚠️ a crewless worker never emits crew_id.is.null',
    !crewless.includes('is.null') && !crewless.includes('crew_id'), crewless)
}

// ── 3. Refusals say nothing, and fail closed ────────────────────────────────
section('3. The refusal vocabulary')
{
  check('an unassigned/foreign/absent visit is 404, not 403',
    WORKER_DENIAL_STATUS['not-assigned'] === 404,
    'a 403 next to a 404 tells a prober which ids are real')
  check('a failed lookup refuses (5xx), never falls through',
    WORKER_DENIAL_STATUS['lookup-failed'] >= 500)
  check('no service role configured refuses (503)',
    WORKER_DENIAL_STATUS['unavailable'] === 503)
  check('a non-worker is 403',
    WORKER_DENIAL_STATUS['not-a-worker'] === 403)
  check('no session is 401',
    WORKER_DENIAL_STATUS['signed-out'] === 401)

  const messages = Object.values(WORKER_DENIAL_MESSAGE)
  const leaks = /technicians|jobs\b|crew_id|technician_id|user_id|auth\.uid|postgres|pgrst|relation|column|policy|rls/i
  check('no refusal message leaks database vocabulary',
    messages.every(m => !leaks.test(m)), messages.filter(m => leaks.test(m)).join(' | '))
  check('every refusal message is a sentence a person can act on',
    messages.every(m => m.length > 12 && /[.!]$/.test(m)))

  check('a malformed id is refused before it reaches the database',
    !isUuid('not-a-uuid') && !isUuid('') && !isUuid(null) &&
    isUuid('00000000-0000-0000-0000-00000000000a'))
  // ⭐ A SQL-ish payload is not a uuid, so it never reaches a query at all.
  check('an injection-shaped id is refused by shape',
    !isUuid("' or 1=1 --") && !isUuid('00000000-0000-0000-0000-00000000000a OR 1=1'))
}

// ── 4. Transitions: the field lifecycle, and only it ────────────────────────
section('4. What a worker may do to a visit')
{
  check('scheduled → in_progress (start)', workerMayTransition('scheduled', 'in_progress'))
  check('in_progress → completed (finish)', workerMayTransition('in_progress', 'completed'))
  check('in_progress → scheduled (done for today / undo start)',
    workerMayTransition('in_progress', 'scheduled'))
  check('completed → in_progress (undo a mis-tap)',
    workerMayTransition('completed', 'in_progress'))

  check('⛔ nothing may move to cancelled — calling off booked work is the office’s',
    !workerMayTransition('scheduled', 'cancelled') &&
    !workerMayTransition('in_progress', 'cancelled') &&
    !workerMayTransition('completed', 'cancelled'))
  check('⛔ a cancelled visit is not a worker origin either',
    !workerMayTransition('cancelled', 'in_progress'))
  check('⛔ scheduled → completed skips the work itself',
    !workerMayTransition('scheduled', 'completed'))
  check('an unknown status is refused both ways',
    !workerMayTransition('invoiced', 'completed') && !workerMayTransition('completed', 'invoiced'))
  check('cancelled is not a worker status at all', !isWorkerVisitStatus('cancelled'))

  // ⭐ The product's graph must never promise more than the RPC will honour.
  const sql = allSql()
  const allow = /crew may not set a visit to/.test(sql)
  check('crew_set_visit_status still refuses statuses outside its allowlist', allow)
  const listed = /p_status not in \(([^)]*)\)/.exec(sql)?.[1] ?? ''
  const dbStatuses = [...listed.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort()
  check('the TS graph and the SQL allowlist name the SAME states',
    JSON.stringify(dbStatuses) === JSON.stringify([...WORKER_VISIT_STATUSES].sort()),
    `sql=${JSON.stringify(dbStatuses)} ts=${JSON.stringify([...WORKER_VISIT_STATUSES].sort())}`)
}

// ── 5. One layer, called by every door ──────────────────────────────────────
section('5. Every worker door goes through the canonical layer')
{
  for (const r of WORKER_ROUTES) {
    const src = strip(SRC(r))
    check(`${r} imports lib/workerAccess`,
      /from '@\/lib\/workerAccess'/.test(src))
    // ⚠️ Specifically the VISIT door, not "any export of the module". Accepting
    // resolveWorker here let a mutation that stubbed out authorizeWorkerVisit
    // survive, because the file still called resolveWorker elsewhere.
    check(`${r} authorises the named visit through authorizeWorkerVisit`,
      /await authorizeWorkerVisit\(/.test(src))
    check(`${r} does not fake an authorisation result`,
      !/const auth\s*=\s*\{/.test(src), 'an object literal is not an authorisation')
    // ⭐ THE REGRESSION THIS GUARD EXISTS FOR: the pre-S66 shape, which asked
    // only about the crew and refused a crewless worker at the door.
    check(`${r} keeps NO rival crew-only gate`,
      !/\.eq\('crew_id',\s*t\.crew_id\)/.test(src) && !/!t\.crew_id/.test(src),
      'a second assignment model is how a by-name assignee got locked out')
    check(`${r} does not re-read the roster by hand`,
      !/from\('technicians'\)[\s\S]{0,200}auth_user_id/.test(src),
      'identity is resolveWorker’s answer, not each door’s')
  }

  // ⛔ Authorisation must not become a client-side concern.
  const clientImporters: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join('src', dir), { withFileTypes: true })) {
      const rel = join(dir, e.name)
      if (e.isDirectory()) { walk(rel); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      const raw = readFileSync(join('src', rel), 'utf8')
      if (/from '@\/lib\/workerAccess'/.test(strip(raw)) && /^'use client'/m.test(raw)) {
        clientImporters.push(rel)
      }
    }
  }
  walk('.')
  check('⛔ no client component imports the authorisation layer',
    clientImporters.length === 0, clientImporters.join(', '))
}

// ── 6. The layer itself: which predicates actually reach the database ───────
// ⭐⭐ WHY THIS SECTION EXISTS. Sections 1–5 test the pure predicate and the
// source text; section 7 tests the SQL doors. None of them notices if
// `authorizeWorkerVisit` simply STOPS SENDING a filter — the tenant predicate,
// the is_active switch, the archived exclusion — because those live in a query
// builder, not in a pure function. Mutation testing proved it: deleting
// `.eq('user_id', worker.employerId)` left every other check green. So this
// section runs the real functions against a recording client and asserts on the
// filters that were actually sent, plus the fail-closed paths.
section('6. The authorisation layer sends the predicates it claims to')
{
  type Filter = { op: string; col: string; val: unknown }
  const makeClient = (results: Record<string, { data: unknown; error: unknown }>) => {
    const seen: Record<string, Filter[]> = {}
    let table = ''
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => { seen[table].push({ op: 'eq', col, val }); return builder },
      is: (col: string, val: unknown) => { seen[table].push({ op: 'is', col, val }); return builder },
      neq: (col: string, val: unknown) => { seen[table].push({ op: 'neq', col, val }); return builder },
      maybeSingle: async () => results[table] ?? { data: null, error: null },
    }
    const client: any = {
      from: (t: string) => { table = t; seen[t] ||= []; return builder },
    }
    return { client, seen }
  }
  const has = (fs: Filter[] | undefined, op: string, col: string, val?: unknown) =>
    !!fs?.some(f => f.op === op && f.col === col && (val === undefined || f.val === val))

  const TECH = { id: 't1', user_id: 'ownerA', crew_id: 'c1' }

  // — the identity resolver —
  {
    const { client, seen } = makeClient({ technicians: { data: TECH, error: null } })
    const r = await resolveWorker(client, 'uid-1')
    check('resolveWorker returns the roster identity', r.ok && r.worker.employerId === 'ownerA')
    check('… filtered by this session’s auth_user_id', has(seen.technicians, 'eq', 'auth_user_id', 'uid-1'))
    check('⭐ … and by is_active = true (the DISABLE switch)',
      has(seen.technicians, 'eq', 'is_active', true),
      'without this a switched-off worker keeps working')
    check('⭐ … and by archived_at is null',
      has(seen.technicians, 'is', 'archived_at', null))
  }
  {
    const { client } = makeClient({ technicians: { data: null, error: { message: 'boom' } } })
    const r = await resolveWorker(client, 'uid-1')
    check('⭐ a FAILED roster read refuses (never falls through)',
      !r.ok && r.denial === 'lookup-failed')
  }
  {
    const { client } = makeClient({ technicians: { data: null, error: null } })
    const r = await resolveWorker(client, 'uid-1')
    check('an unlinked account is not a worker', !r.ok && r.denial === 'not-a-worker')
  }
  check('no session refuses before any query',
    !(await resolveWorker(makeClient({}).client, null)).ok)
  check('no service role refuses (503 path)',
    !(await resolveWorker(null, 'uid-1')).ok)

  // — the visit door —
  {
    const { client, seen } = makeClient({
      technicians: { data: TECH, error: null },
      jobs: { data: { id: 'j1', user_id: 'ownerA', crew_id: 'c1', technician_id: null }, error: null },
    })
    const a = await authorizeWorkerVisit(client, 'uid-1', '00000000-0000-0000-0000-0000000000f1')
    check('an assigned visit authorises', a.ok)
    check('⭐⭐ … and the TENANT predicate was actually sent',
      has(seen.jobs, 'eq', 'user_id', 'ownerA'),
      'without it a job id from another business resolves')
    check('… scoped to the requested id', has(seen.jobs, 'eq', 'id'))
  }
  {
    // The visit exists in this tenant but belongs to another crew and another
    // person: the door must refuse on COVERAGE, not on the tenant.
    const { client } = makeClient({
      technicians: { data: TECH, error: null },
      jobs: { data: { id: 'j2', user_id: 'ownerA', crew_id: 'c2', technician_id: 't9' }, error: null },
    })
    const a = await authorizeWorkerVisit(client, 'uid-1', '00000000-0000-0000-0000-0000000000f2')
    check('⭐⭐ a same-tenant visit this worker is NOT assigned to is refused',
      !a.ok && a.denial === 'not-assigned',
      'this is the check that stops one worker reading another’s work')
  }
  {
    const { client } = makeClient({
      technicians: { data: TECH, error: null },
      jobs: { data: null, error: { message: 'boom' } },
    })
    const a = await authorizeWorkerVisit(client, 'uid-1', '00000000-0000-0000-0000-0000000000f3')
    check('⭐ a FAILED visit read refuses', !a.ok && a.denial === 'lookup-failed')
  }
  {
    const { client } = makeClient({ technicians: { data: TECH, error: null } })
    const a = await authorizeWorkerVisit(client, 'uid-1', 'not-a-uuid')
    check('a malformed id never reaches the visit query', !a.ok && a.denial === 'not-assigned')
  }
}

// ── 7. The database: the same question, and the attacks ─────────────────────
section('6. The database enforces it (PGlite)')
const booted = await bootCrewDb()
if ('skipped' in booted) {
  console.log(`  … skipped — ${booted.skipped}`)
} else {
  const db = booted
  const { ownerA, ownerB, crewA1, crewA2, techA1, techA2, techB1, customerA, jobA } = db.ids

  // Link three workers to auth accounts: Jane (crew A1), Peter (NO crew — the
  // by-name case S65 added), and a worker at the other tenant.
  const uidJane = '00000000-0000-0000-0000-0000000000a1'
  const uidPeter = '00000000-0000-0000-0000-0000000000a2'
  const uidOther = '00000000-0000-0000-0000-0000000000b1'
  await db.exec(`insert into auth.users (id, email) values
    ('${uidJane}','jane@example.test'), ('${uidPeter}','peter@example.test'), ('${uidOther}','other@example.test')`)
  await db.exec(`update public.technicians set auth_user_id = '${uidJane}'  where id = '${techA1}'`)
  await db.exec(`update public.technicians set auth_user_id = '${uidPeter}' where id = '${techA2}'`)
  await db.exec(`update public.technicians set auth_user_id = '${uidOther}' where id = '${techB1}'`)

  // A second crew's visit, a by-name visit for Peter, and an UNASSIGNED visit.
  const jobOther = '00000000-0000-0000-0000-0000000000f2'
  const jobPeter = '00000000-0000-0000-0000-0000000000f3'
  const jobNone  = '00000000-0000-0000-0000-0000000000f4'
  const jobTenantB = '00000000-0000-0000-0000-0000000000f5'
  await db.exec(`insert into public.jobs (id, user_id, customer_id, title, scheduled_date, crew_id) values
    ('${jobOther}', '${ownerA}', '${customerA}', 'Other crew', current_date, '${crewA2}')`)
  await db.exec(`insert into public.jobs (id, user_id, customer_id, title, scheduled_date, technician_id) values
    ('${jobPeter}', '${ownerA}', '${customerA}', 'Peter alone', current_date, '${techA2}')`)
  await db.exec(`insert into public.jobs (id, user_id, customer_id, title, scheduled_date) values
    ('${jobNone}', '${ownerA}', '${customerA}', 'Nobody yet', current_date)`)
  await db.exec(`insert into public.jobs (id, user_id, title, scheduled_date) values
    ('${jobTenantB}', '${ownerB}', 'Tenant B work', current_date)`)

  const stopIds = async (uid: string): Promise<string[]> => {
    await db.asUser(uid)
    const r = await db.query(`select public.crew_day(current_date) as d`)
    const stops = r.rows[0]?.d?.stops ?? []
    return stops.map((s: any) => s.id).sort()
  }

  // ── identity + assignment ────────────────────────────────────────────────
  const janeStops = await stopIds(uidJane)
  check('a crew worker sees their crew’s visit', janeStops.includes(jobA))
  check('… and NOT the other crew’s', !janeStops.includes(jobOther))
  check('… and NOT the unassigned one', !janeStops.includes(jobNone))
  check('… and NOT another tenant’s', !janeStops.includes(jobTenantB))

  const peterStops = await stopIds(uidPeter)
  check('⭐ a BY-NAME worker sees the visit assigned to them', peterStops.includes(jobPeter))
  check('⚠️ a CREWLESS worker does NOT see the unassigned visit',
    !peterStops.includes(jobNone),
    'null crew matching null assignment would hand over the whole book')
  check('a crewless worker sees no crew’s work', !peterStops.includes(jobA) && !peterStops.includes(jobOther))

  await db.asUser(uidOther)
  const otherDay = (await db.query(`select public.crew_day(current_date) as d`)).rows[0]?.d
  const otherStops = (otherDay?.stops ?? []).map((s: any) => s.id)
  check('⭐ a worker at another tenant sees NONE of tenant A’s visits',
    !otherStops.includes(jobA) && !otherStops.includes(jobPeter) && !otherStops.includes(jobNone))

  // ── forged ids get nothing ───────────────────────────────────────────────
  await db.asUser(uidJane)
  const forged = await db.query(
    `select public.crew_job_forms('${jobTenantB}') as a,
            public.crew_job_forms('${jobOther}')  as b,
            public.crew_job_forms('${jobNone}')   as c`)
  check('a forged job id from ANOTHER TENANT returns nothing',
    forged.rows[0].a === null)
  check('a job id from ANOTHER CREW returns nothing', forged.rows[0].b === null)
  check('an UNASSIGNED job id returns nothing', forged.rows[0].c === null)

  // ⭐ THE FIX: the by-name assignee can now open their own checklist.
  await db.asUser(uidPeter)
  const mine = await db.query(`select public.crew_job_forms('${jobPeter}') as f`)
  check('⭐ a BY-NAME worker can open their own visit’s checklist (was null before S66)',
    mine.rows[0].f !== null)
  const notMine = await db.query(`select public.crew_job_forms('${jobA}') as f`)
  check('… and still not somebody else’s', notMine.rows[0].f === null)

  // ⭐⭐ ensure_job_forms is called DIRECTLY here, not through crew_job_forms.
  // crew_job_forms returns early for an unassigned worker, so testing only
  // through it leaves ensure_job_forms' own crew branch unchecked — a mutation
  // that made it mint for ANY worker at the employer survived exactly that way.
  // Minting is a WRITE: an unassigned worker must materialise nothing.
  //
  // ⚠️⚠️ AND IT NEEDS SOMETHING TO MINT. Written without the fixture below, the
  // "mints nothing" assertion passed against a job with no default template —
  // proving only that nothing was mintable. The POSITIVE control at the end is
  // what makes the negative mean anything.
  const ftId = '00000000-0000-0000-0000-0000000000aa'
  const stId = '00000000-0000-0000-0000-0000000000ab'
  // ⭐ As the OWNER. Setting service_type while still acting as a worker is
  // refused by crew_job_field_guard — correctly, since that is the trigger that
  // stops a worker editing anything but a visit's status. The fixture is
  // office-side setup, so it runs as the office.
  await db.asUser(ownerA)
  await db.exec(`insert into public.form_templates (id, user_id, name) values
    ('${ftId}', '${ownerA}', 'Site checklist')`)
  await db.exec(`insert into public.service_templates (id, user_id, name, form_template_id) values
    ('${stId}', '${ownerA}', 'Mowing', '${ftId}')`)
  await db.exec(`update public.jobs set service_type = 'Mowing' where id in ('${jobA}', '${jobPeter}')`)

  const formCount = async (job: string) =>
    Number((await db.query(`select count(*) as n from public.job_forms where job_id = '${job}'`)).rows[0].n)

  const beforeMint = await formCount(jobA)
  await db.asUser(uidPeter)   // Peter is assigned by name to a DIFFERENT visit
  const peerRows = await db.query(`select * from public.ensure_job_forms('${jobA}')`)
  check('⭐⭐ an UNASSIGNED worker mints nothing (ensure_job_forms, called direct)',
    (await formCount(jobA)) === beforeMint,
    `before=${beforeMint} after=${await formCount(jobA)}`)
  check('⭐ … and is told nothing about that visit’s forms', peerRows.rows.length === 0)

  // ⭐ POSITIVE CONTROL — the assigned worker DOES mint. Without this the check
  // above is satisfied by a job that could never have had a form at all.
  await db.asUser(uidJane)
  await db.query(`select * from public.ensure_job_forms('${jobA}')`)
  check('⭐ positive control: the ASSIGNED worker does mint the checklist',
    (await formCount(jobA)) === beforeMint + 1,
    `before=${beforeMint} after=${await formCount(jobA)} — if this fails the negative above proves nothing`)

  // ── the write boundary ───────────────────────────────────────────────────
  await db.asUser(uidJane)
  const cancelled = await db.expectRefusal(
    `select public.crew_set_visit_status('${jobA}', 'cancelled', (select updated_at from public.jobs where id='${jobA}'))`)
  check('⛔ a worker may not cancel a visit', cancelled !== null, 'it succeeded')

  const selfAssign = await db.expectRefusal(
    `update public.jobs set crew_id = '${crewA1}' where id = '${jobOther}'`)
  check('⛔ a worker may not re-assign a visit to their own crew (self-promotion)',
    selfAssign !== null, 'it succeeded')
  const selfName = await db.expectRefusal(
    `update public.jobs set technician_id = '${techA1}' where id = '${jobNone}'`)
  check('⛔ a worker may not assign themselves an unassigned visit',
    selfName !== null, 'it succeeded')
  const repriced = await db.expectRefusal(
    `update public.jobs set price = 1 where id = '${jobA}'`)
  check('⛔ a worker may not change a visit’s price', repriced !== null, 'it succeeded')
  const moved = await db.expectRefusal(
    `update public.jobs set customer_id = '${customerA}', scheduled_date = current_date + 1 where id = '${jobA}'`)
  check('⛔ a worker may not move a visit or re-point it at a customer',
    moved !== null, 'it succeeded')

  // ── the owner's business is not the worker's ─────────────────────────────
  // ⚠️⚠️ THE ROLE IS THE WHOLE TEST. PGlite runs as a superuser, which BYPASSES
  // RLS — so reading these tables without switching role asserts nothing at all
  // and passes even if every policy were dropped. `set local role` is also a
  // NO-OP outside a transaction, so the begin/rollback is load-bearing too.
  // Written the obvious way, this check was green while proving nothing.
  await db.exec('begin')
  await db.exec('set local role authenticated')
  const owned = await db.query(`
    select (select count(*) from public.customers)        as customers,
           (select count(*) from public.business_settings) as settings,
           (select count(*) from public.crews)             as crews`)
  await db.exec('rollback')
  check('⭐ a worker reading tables directly sees NO customers (RLS, owner-scoped)',
    Number(owned.rows[0].customers) === 0)
  check('⭐ … no business settings', Number(owned.rows[0].settings) === 0)
  check('⭐ … and no crew rows', Number(owned.rows[0].crews) === 0)

  // ── a disabled worker ────────────────────────────────────────────────────
  await db.exec(`update public.technicians set is_active = false where id = '${techA1}'`)
  await db.asUser(uidJane)
  const afterOff = await db.query(`select public.crew_day(current_date) as d, public.current_app_role() as r`)
  check('⭐ a DISABLED worker’s day returns nothing at all', afterOff.rows[0].d === null)
  check('⭐ … and they are no longer a crew role', afterOff.rows[0].r !== 'crew')
  const offWrite = await db.expectRefusal(
    `select public.crew_set_visit_status('${jobA}', 'in_progress', (select updated_at from public.jobs where id='${jobA}'))`)
  check('⭐ a disabled worker cannot write', offWrite !== null, 'it succeeded')

  // ⭐ Disabling is not deletion: the roster row and its identity survive.
  const still = await db.query(
    `select count(*) as n from public.technicians where id = '${techA1}'`)
  check('⭐ the disabled worker’s row still exists — history stays attributable',
    Number(still.rows[0].n) === 1)
  await db.exec(`update public.technicians set is_active = true where id = '${techA1}'`)

  await db.close()
}

console.log(`\n── ${pass} passed, ${fail} failed ──\n`)
if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
