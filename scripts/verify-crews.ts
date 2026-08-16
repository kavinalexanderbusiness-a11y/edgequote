// ── verify:crews ─────────────────────────────────────────────────────────────
//
// THE CLAIMS THIS GUARD TESTS:
//   1. A crew is a real, tenant-owned object: named, orderable, deactivatable,
//      with an optional lead who must actually be on it.
//   2. A worker belongs to at most ONE crew, and every change to that is
//      recorded — so who was on which crew last Tuesday cannot be rewritten by
//      moving somebody today.
//   3. A crew that has run work cannot be deleted, only deactivated.
//   4. None of it can be reached across a tenant boundary.
//
// Claims 1–4 are enforced by the DATABASE, so the second half of this file
// applies the real migration to a real Postgres and ATTACKS it. A grep over the
// migration would only prove the text exists.
//
// Universality is also pinned here: a crew is a set of people with a name, and
// nothing in the crew engine may branch on what trade the business is in.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootCrewDb } from './lib/crew-db'
import {
  crewIdAsOf, crewMembersAsOf, describeMembershipBasis,
} from '../src/lib/crewAssignment'
import type { CrewMembershipChange } from '../src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const section = (t: string) => console.log(`\n■ ${t}`)

const SRC = (p: string) => readFileSync(join('src', p), 'utf8')
/** Comments are stripped before any prose assertion — a file DOCUMENTING a rule
 *  must never be mistaken for a file BREAKING it (the cure reading as the
 *  disease). CRLF-safe: `.` does not match \r. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\r\n]*\/\/[^\r\n]*$/gm, '')

async function main() {
console.log('\n══ verify:crews ═══════════════════════════════════════════════════════')

// ── 1. Membership as of a moment (pure) ──────────────────────────────────────
section('1. Membership history answers "which crew, back THEN"')

const H = (technician_id: string, crew_id: string | null, changed_at: string): CrewMembershipChange =>
  ({ id: `${technician_id}-${changed_at}`, user_id: 'owner', technician_id, crew_id, changed_at });

{
  const history = [
    H('jane', 'crewA', '2026-01-01T00:00:00Z'),
    H('jane', 'crewB', '2026-06-01T00:00:00Z'),
    H('pete', 'crewB', '2026-03-01T00:00:00Z'),
  ]

  const march = crewIdAsOf(history, 'jane', '2026-03-15T12:00:00Z')
  check('a shift in March reads the crew Jane was on in March',
    march.known && march.crewId === 'crewA', JSON.stringify(march))

  const july = crewIdAsOf(history, 'jane', '2026-07-15T12:00:00Z')
  check('after the move, the same person reads as the new crew',
    july.known && july.crewId === 'crewB', JSON.stringify(july))

  // ⭐⭐ THE FALSIFICATION THIS WHOLE TABLE EXISTS TO PREVENT.
  check('moving somebody today does NOT rewrite what March says',
    crewIdAsOf([...history, H('jane', 'crewC', '2026-08-15T00:00:00Z')], 'jane', '2026-03-15T12:00:00Z').crewId === 'crewA')

  const before = crewIdAsOf(history, 'jane', '2025-12-01T00:00:00Z')
  check('a moment BEFORE the log starts is unknown, not "no crew"',
    !before.known, JSON.stringify(before))
  check('unknown is reported as a distinct basis, in words',
    describeMembershipBasis('current_roster').includes('no record') &&
    describeMembershipBasis('recorded').includes('recorded'))

  check('leaving a crew is recorded as leaving, not as absence',
    crewIdAsOf([...history, H('pete', null, '2026-07-01T00:00:00Z')], 'pete', '2026-08-01T00:00:00Z').crewId === null)

  const members = crewMembersAsOf(history, 'crewB', '2026-07-01T00:00:00Z')
  check('a crew\'s membership at a moment lists exactly who was on it then',
    members.join(',') === 'jane,pete', members.join(','))
  check('…and not who joined later',
    crewMembersAsOf(history, 'crewB', '2026-02-01T00:00:00Z').length === 0)
}

// ── 2. No trade knowledge anywhere in the crew engine ────────────────────────
section('2. Universal — a crew is people with a name, whatever the trade')
{
  const engine = stripComments(SRC('lib/crewAssignment.ts'))
  const crewsLib = stripComments(SRC('lib/crews.ts'))
  // Words from six different trades. Any of them appearing as LOGIC in the crew
  // engine would mean the model had learned what the business does.
  //
  // ⚠️ Whole words only, and no bare 'clean' — `const clean = name.trim()` is a
  // trimmed string, not a cleaning company, and a guard that cannot tell those
  // apart trains people to ignore it.
  const TRADES = [
    'lawn', 'mow', 'hvac', 'furnace', 'cleaning', 'painting', 'plumbing',
    'electrical', 'landscap\\w*', 'snow', 'roofing', 'irrigation',
  ]
  const hits = TRADES.filter(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(engine) || new RegExp(`\\b${w}\\b`, 'i').test(crewsLib))
  check('no service/trade keyword drives crew or assignment behaviour',
    hits.length === 0, hits.length ? `found: ${hits.join(', ')}` : '')
  check('mechanism control: the scan can see words that ARE there',
    /crew/i.test(engine) && /assign/i.test(engine))
}

// ── 3. Payroll stays out of the crew object ──────────────────────────────────
section('3. A crew carries no money')
{
  const migration = readFileSync(
    join('supabase', 'migrations', '20260815120000_crews_team_assignments_v1.sql'), 'utf8')
  // The crew table's own columns, as this migration leaves them.
  const MONEY = ['wage', 'hourly', 'salary', 'pay_rate', 'cost_per_hour', 'price']
  const crewTouching = migration.split('\n').filter(l =>
    /alter table public\.crews|create table if not exists public\.crews/i.test(l))
  const moneyOnCrew = MONEY.filter(w => crewTouching.some(l => new RegExp(w, 'i').test(l)))
  check('the migration adds no wage/pay column to crews',
    moneyOnCrew.length === 0, moneyOnCrew.join(', '))

  const panel = stripComments(SRC('components/workforce/CrewsPanel.tsx'))
  const editor = stripComments(SRC('components/workforce/CrewEditor.tsx'))
  const moneyInUi = ['hourly_wage', 'wage', 'payroll', 'salary']
    .filter(w => new RegExp(w, 'i').test(panel) || new RegExp(w, 'i').test(editor))
  check('the crew surfaces show no wage or payroll figure',
    moneyInUi.length === 0, moneyInUi.join(', '))
}

// ── 4. Crew money follows the crew somebody was on at the time ───────────────
section('4. Labour attribution reads history, not today\'s roster')
{
  const labor = stripComments(SRC('lib/laborCost.ts'))
  check('a crew bucket resolves membership through crewOfShift',
    /laborByCrew[\s\S]*?crewOfShift\(e, ctx\)/.test(labor))
  check('crew profitability does too',
    /crewProfitability[\s\S]*?crewOfShift\(e, ctx\)/.test(labor))
  check('crewOfShift asks the log first and falls back explicitly',
    /crewIdAsOf\(ctx\.crewHistory/.test(labor) && /basis: 'current_roster'/.test(labor))
  check('the fallback is reportable, so a surface can disclose it',
    /export function crewAttributionBasis/.test(labor))
}

// ── 5. The database itself ───────────────────────────────────────────────────
section('5. Attacking the real schema')
const boot = await bootCrewDb()
if ('skipped' in boot) {
  console.log(`  ⏭  database half SKIPPED — ${boot.skipped}`)
} else {
  const db = boot
  const { ids } = db

  // — tenancy —
  check('a worker cannot be put on ANOTHER tenant\'s crew',
    (await db.expectRefusal(
      `update public.technicians set crew_id = '${ids.crewB1}' where id = '${ids.techA1}'`)) != null,
    'tenant A\'s worker joined tenant B\'s crew')

  check('a visit cannot be assigned to another tenant\'s crew',
    (await db.expectRefusal(
      `update public.jobs set crew_id = '${ids.crewB1}' where id = '${ids.jobA}'`)) != null)

  check('a visit cannot be assigned to another tenant\'s worker',
    (await db.expectRefusal(
      `update public.jobs set crew_id = null, technician_id = '${ids.techB1}' where id = '${ids.jobA}'`)) != null)

  check('a forged crew id is refused outright',
    (await db.expectRefusal(
      `update public.jobs set crew_id = '00000000-0000-0000-0000-0000000000ff' where id = '${ids.jobA}'`)) != null)

  check('another tenant\'s crew cannot lead with your worker',
    (await db.expectRefusal(
      `update public.crews set lead_technician_id = '${ids.techA1}' where id = '${ids.crewB1}'`)) != null)

  // — the lead is a member —
  check('a crew lead must be on that crew',
    (await db.expectRefusal(
      `update public.crews set lead_technician_id = '${ids.techA2}' where id = '${ids.crewA1}'`)) != null,
    'Peter is on no crew but was accepted as Crew A\'s lead')

  await db.exec(`update public.crews set lead_technician_id = '${ids.techA1}' where id = '${ids.crewA1}'`)
  const lead0 = await db.query(`select lead_technician_id from public.crews where id = '${ids.crewA1}'`)
  check('a member CAN be made lead', lead0.rows[0].lead_technician_id === ids.techA1)

  await db.exec(`update public.technicians set crew_id = '${ids.crewA2}' where id = '${ids.techA1}'`)
  const lead1 = await db.query(`select lead_technician_id from public.crews where id = '${ids.crewA1}'`)
  check('leaving the crew clears the lead pointer automatically',
    lead1.rows[0].lead_technician_id === null,
    'a departed member is still recorded as leading the crew')

  // — history —
  const hist = await db.query(
    `select crew_id, changed_at from public.technician_crew_history
      where technician_id = '${ids.techA1}' order by changed_at`)
  check('every membership change appends a row (seed + join + move)',
    hist.rows.length >= 2, `${hist.rows.length} rows`)
  check('the newest row records the crew they moved TO',
    hist.rows[hist.rows.length - 1].crew_id === ids.crewA2)

  const beforeCount = (await db.query('select count(*)::int n from public.technician_crew_history')).rows[0].n
  await db.exec(`update public.technicians set name = 'Jane Renamed' where id = '${ids.techA1}'`)
  const afterCount = (await db.query('select count(*)::int n from public.technician_crew_history')).rows[0].n
  check('a change that is NOT a crew move writes no history row',
    beforeCount === afterCount, `${beforeCount} → ${afterCount}`)

  // — history is not editable by a client role —
  await db.exec(`set local role authenticated`).catch(() => {})
  const grants = await db.query(`
    select coalesce(string_agg(privilege_type, ','), '') as p
    from information_schema.role_table_grants
    where table_name = 'technician_crew_history' and grantee = 'authenticated'`)
  check('a signed-in client may only SELECT the membership log',
    grants.rows[0].p === 'SELECT', `granted: ${grants.rows[0].p || '(none)'}`)

  const policies = await db.query(`
    select cmd from pg_policies where tablename = 'technician_crew_history'`)
  check('…and its only policy is a read of your own tenant\'s rows',
    policies.rows.length === 1 && policies.rows[0].cmd === 'SELECT',
    policies.rows.map((r: any) => r.cmd).join(','))

  // — deleting a crew with history —
  check('a crew that has run work cannot be deleted',
    (await db.expectRefusal(`delete from public.crews where id = '${ids.crewA1}'`)) != null,
    'deleting it would have SET NULL every past visit\'s crew')

  await db.exec(`insert into public.crews (id, user_id, name) values
    ('00000000-0000-0000-0000-0000000000c9', '${ids.ownerA}', 'Never used')`)
  const delErr = await db.expectRefusal(`delete from public.crews where id = '00000000-0000-0000-0000-0000000000c9'`)
  check('a crew that never ran anything CAN still be deleted', delErr === null,
    `refused with: ${delErr}`)

  // — deactivation —
  await db.exec(`update public.crews set is_active = false where id = '${ids.crewA2}'`)
  check('a deactivated crew takes no NEW work',
    (await db.expectRefusal(
      `insert into public.jobs (user_id, customer_id, title, scheduled_date, crew_id)
       values ('${ids.ownerA}', '${ids.customerA}', 'New work', current_date, '${ids.crewA2}')`)) != null)

  const keptRows = await db.query(
    `select count(*)::int n from public.jobs where crew_id = '${ids.crewA1}'`)
  check('…while work already on a crew is untouched by any of this',
    keptRows.rows[0].n === 1, `${keptRows.rows[0].n} visits still attached`)

  // — an archived person —
  await db.exec(`update public.technicians set is_active = false where id = '${ids.techA2}'`)
  check('somebody off the roster cannot be given new work',
    (await db.expectRefusal(
      `update public.jobs set crew_id = null, technician_id = '${ids.techA2}' where id = '${ids.jobA}'`)) != null)

  await db.close()
}

// ── 6. The rendered surface, and whether a phone can use it ─────────────────
// These are client components: an HTTP request returns a skeleton, so rendering
// them here is the closest honest substitute for looking. It is not a substitute
// for a real viewport — what it CAN prove is that the markup says the right
// things once, and that nothing in it is hidden or clipped on a narrow screen.
//
// Two mechanics (same as verify:team): createElement rather than JSX, because
// this file runs under the app's `jsx: preserve` tsconfig; and React goes on the
// global first, because the components compile to the classic runtime.
section('6. What the owner actually sees, at 375px')
{
  const React = require('react') as typeof import('react')
  ;(globalThis as Record<string, unknown>).React = React
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
  const { CrewsPanel } = require('../src/components/workforce/CrewsPanel') as typeof import('../src/components/workforce/CrewsPanel')

  const c = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, name, user_id: 'o', created_at: '', updated_at: '', color: 'emerald',
    day_start: null, day_end: null, capacity_minutes: null, is_active: true, sort_order: 0, ...over,
  })
  const t = (id: string, name: string) => ({
    id, name, user_id: 'o', created_at: '', updated_at: '', crew_id: 'c1', phone: null, email: null,
    role: null, status: 'available', status_changed_at: '', is_active: true, hourly_wage: 31,
    hired_on: null, ended_on: null, pto_annual_hours: null, archived_at: null,
  })

  const html = renderToStaticMarkup(React.createElement(CrewsPanel as any, {
    rows: [
      { crew: c('c1', 'Crew A'), members: [t('t1', 'Jane'), t('t2', 'Peter')], leadName: 'Jane',
        today: 3, upcoming: 8, availableToday: 1 },
      { crew: c('c2', 'Install Crew'), members: [], leadName: null, today: 2, upcoming: 0, availableToday: 0 },
      { crew: c('c3', 'Old Crew', { is_active: false }), members: [], leadName: null,
        today: 0, upcoming: 0, availableToday: 0 },
    ],
    onOpen: () => {}, onCreate: async () => null,
  }))
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  check('the list counts running and deactivated crews',
    /2 running · 1 deactivated/.test(text), text.slice(0, 140))
  check('a crew says how many people are on it',
    /Crew A[\s\S]{0,160}2 people/.test(text))
  check('the lead is named on the row', /Jane/.test(text))
  check('an empty crew holding work says so in the strongest words',
    /Install Crew[\s\S]{0,220}Work today, nobody to do it/.test(text),
    text.slice(text.indexOf('Install Crew'), text.indexOf('Install Crew') + 220))
  check('somebody booked off is reported separately from headcount',
    /1 booked off today/.test(text))
  check('a deactivated crew is grouped, and its history promised',
    /Deactivated — their past work is kept/.test(text))

  // ⛔ No wage may reach this surface even though the fixture carries one.
  check('no wage appears on the crews list', !/31/.test(text) && !/wage/i.test(text))

  // ── Narrow-screen layout ──
  // ⚠️ This Tailwind config defines NO `xs:` breakpoint — a class using one is
  // invisible on every phone. That shipped once already (workforce team home).
  check('no xs: breakpoint (this config has none — the content would vanish)',
    !/\bxs:/.test(html), (html.match(/\bxs:[\w-]+/g) || []).slice(0, 4).join(' '))
  check('the chip rows wrap instead of clipping at 375px',
    (html.match(/flex-wrap/g) || []).length >= 2)
  check('nothing is pinned to a width a 375px screen cannot hold',
    !/\b(w|min-w)-\[(4[0-9][0-9]|[5-9][0-9]{2}|[0-9]{4,})px\]/.test(html),
    (html.match(/\b(?:w|min-w)-\[\d+px\]/g) || []).join(' '))
  check('a crew row is one full-width tap target, not a cluster of small ones',
    /<button[^>]+class="[^"]*w-full[^"]*py-3/.test(html))
  check('the row keeps a truncating title so a long crew name cannot push it wide',
    /truncate/.test(html))

  // The editor's copy is the promise the whole history table exists to keep.
  const editorSrc = SRC('components/workforce/CrewEditor.tsx')
  check('removing somebody promises their finished work is untouched',
    /never rewritten|stays exactly as it is/.test(editorSrc))
  check('deactivating warns when upcoming work would be stranded',
    /still booked to this crew/.test(editorSrc))
  check('deleting points at deactivate instead',
    /deactivate/i.test(editorSrc) && /has run work|never run any work/.test(editorSrc))
}

console.log(`\n${'─'.repeat(70)}`)
if (fail === 0) console.log(`CREWS VERIFIED — ${pass} checks passed.\n`)
else console.error(`CREWS: ${fail} FAILED, ${pass} passed.\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
