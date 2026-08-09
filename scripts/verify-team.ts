// ── Verify: one home for the team, one editor, one vocabulary ────────────────
//   npm run verify:team
//
// WHY THIS SCRIPT EXISTS
// Managing an employee used to be spread over two surfaces with two different
// editors. The list of people lived in a modal behind `?roster=1` on the
// DISPATCH board, while the page called Workforce showed only hours and money —
// so "who works here" was not answerable on the page named after it. The modal's
// editor was six inline fields per person saving themselves on blur, and because
// those inputs were UNCONTROLLED a failed save left the typed value on screen
// looking saved, with no refetch able to correct it.
//
// Both halves of that grow back easily: someone adds a quick inline field to the
// board "just for crew", and there are two answers again. So the shape is
// asserted — the grouping and status derivation as behaviour, and the
// one-editor / one-home rules over the real source.

import {
  employeeStanding, groupTeam, searchTeam, toTeamMember, memberGaps,
  teamSetupSummary, STANDING_LABEL, EMPLOYEE, type TeamMember,
} from '../src/lib/workforceTeam'
import type { Crew, Technician } from '../src/types'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CREWS = [
  { id: 'c1', name: 'North crew', color: 'emerald', is_active: true, sort_order: 0 },
  { id: 'c2', name: 'South crew', color: 'sky', is_active: true, sort_order: 1 },
] as unknown as Crew[]

const tech = (o: Partial<Technician> & { id: string; name: string }): Technician => ({
  created_at: '', updated_at: '', user_id: 'owner', crew_id: null, phone: null, email: null,
  role: null, status: 'available', status_changed_at: '', is_active: true, hourly_wage: null,
  hired_on: null, ended_on: null, pto_annual_hours: null, archived_at: null,
  ...o,
} as Technician)

// ── 1. Standing: three states, three meanings ────────────────────────────────
console.log('\n═══ Who works here ═══')
eq('active and on the roster → working', employeeStanding({ is_active: true, archived_at: null }), 'working')
eq('switched inactive → paused', employeeStanding({ is_active: false, archived_at: null }), 'paused')
eq('archived → former', employeeStanding({ is_active: true, archived_at: '2026-01-01' }), 'former')
// ⭐ Archiving OUTRANKS the active switch. Somebody who has left is not "Active"
// because a boolean nobody thought to clear says so.
eq('archived beats the active switch', employeeStanding({ is_active: true, archived_at: '2026-01-01' }), 'former')
check('every standing has plain-language copy',
  STANDING_LABEL.working === 'Active' && STANDING_LABEL.paused === 'Inactive' && STANDING_LABEL.former === 'Removed')

// ── 2. Grouping: never a mixed list ──────────────────────────────────────────
console.log('\n═══ The list reads without filtering it in your head ═══')
const members = [
  tech({ id: '1', name: 'Zoe', crew_id: 'c1' }),
  tech({ id: '2', name: 'Adam', crew_id: 'c2' }),
  tech({ id: '3', name: 'Mia', is_active: false }),
  tech({ id: '4', name: 'Old Hand', archived_at: '2026-01-01' }),
].map(t => toTeamMember(t, CREWS, null))
const g = groupTeam(members)
eq('working, alphabetically', g.working.map(m => m.name), ['Adam', 'Zoe'])
eq('inactive kept separate', g.paused.map(m => m.name), ['Mia'])
eq('former kept separate again', g.former.map(m => m.name), ['Old Hand'])
check('nobody is in two groups', g.working.length + g.paused.length + g.former.length === members.length)

eq('crew name comes through', g.working.find(m => m.name === 'Adam')?.crewName, 'South crew')
eq('no crew is null, not a guess', g.paused[0].crewName, null)

// ── 3. Search: what an owner would actually type ─────────────────────────────
console.log('\n═══ Finding someone ═══')
const searchable = [
  toTeamMember(tech({ id: '1', name: 'Sam Torres', crew_id: 'c1', phone: '(587) 555-0134', role: 'Crew lead' }), CREWS, null),
  toTeamMember(tech({ id: '2', name: 'Jo Baker', crew_id: 'c2' }), CREWS, null),
]
eq('by name', searchTeam(searchable, 'torres').map(m => m.id), ['1'])
eq('by crew', searchTeam(searchable, 'south').map(m => m.id), ['2'])
eq('by job title', searchTeam(searchable, 'crew lead').map(m => m.id), ['1'])
eq('by phone, however it is punctuated', searchTeam(searchable, '5875550134').map(m => m.id), ['1'])
eq('an empty query is everybody', searchTeam(searchable, '  ').length, 2)

// ── 4. What is still missing ─────────────────────────────────────────────────
console.log('\n═══ “Added but not ready” is visible ═══')
const half = toTeamMember(tech({ id: '9', name: 'New Start' }), CREWS, null)
eq('a half-set-up employee says so', memberGaps(half).map(x => x.kind), ['crew', 'wage', 'access'])
const done = toTeamMember(
  tech({ id: '8', name: 'Ready', crew_id: 'c1', hourly_wage: 28, auth_user_id: 'u1' }),
  CREWS, { linked: true, email: 'r@x.co', last_sign_in_at: '2026-08-01T00:00:00Z' },
)
eq('a finished one says nothing', memberGaps(done), [])
// Gaps are about people who are WORKING — nagging about somebody who left is noise.
eq('nothing is demanded of a former employee',
  memberGaps(toTeamMember(tech({ id: '7', name: 'Gone', archived_at: '2026-01-01' }), CREWS, null)), [])
eq('the summary counts what is missing',
  teamSetupSummary(groupTeam([half, done])), '1 not on a crew · 1 with no wage · 1 without app access')
eq('a set-up team says nothing at all', teamSetupSummary(groupTeam([done])), null)

// ── 5. Access badge agrees with the invite panel ─────────────────────────────
console.log('\n═══ One access answer ═══')
eq('linked + signed in → active',
  toTeamMember(tech({ id: 'a', name: 'A', auth_user_id: 'u' }), CREWS, { linked: true, email: null, last_sign_in_at: '2026-08-01T00:00:00Z' }).access, 'active')
eq('linked, never arrived → invited',
  toTeamMember(tech({ id: 'b', name: 'B', auth_user_id: 'u' }), CREWS, { linked: true, email: null, last_sign_in_at: null }).access, 'invited')
eq('no login → none', toTeamMember(tech({ id: 'c', name: 'C' }), CREWS, null).access, 'none')
// ⭐ The same precedence the invite panel uses: a paused employee cannot get in,
// whatever their link says, so the roster must not advertise them as Active.
eq('inactive beats a working login',
  toTeamMember(tech({ id: 'd', name: 'D', is_active: false, auth_user_id: 'u' }), CREWS, { linked: true, email: null, last_sign_in_at: '2026-08-01T00:00:00Z' }).access, 'disabled')

// ── 6. One home, one editor ──────────────────────────────────────────────────
console.log('\n═══ People live in one place ═══')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const files = walk(SRC).map(p => ({ path: p.slice(SRC.length + 1).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))
check('the source scan found the app', files.length > 200, `only ${files.length} files`)

const workforce = read('src/app/dashboard/workforce/page.tsx')
check('Workforce shows the team', workforce.includes('<TeamPanel'),
  'the page named after the people has to list them')
check('Workforce is where you add and edit one', workforce.includes('<EmployeeEditor'),
  'add/edit must not send the owner to another module')

// ⭐ THE anti-regression: exactly one SCREEN may write a technician row. A second
// inline editor somewhere convenient is how the uncontrolled-save bug comes back.
// Server routes and the shared engines are not screens and are listed by reason.
const ALLOWED_WRITERS: Record<string, string> = {
  'components/workforce/EmployeeEditor.tsx': 'THE employee editor',
  'lib/crews.ts': 'the shared engines (archiveTechnician, setTechnicianStatus) every surface calls',
  'app/api/crew/invite/route.ts': 'the owner-authenticated invite route, linking a login server-side',
}
const writers = files
  .filter(f => /from\('technicians'\)\s*\n?\s*\.(update|insert)/.test(f.text))
  .map(f => f.path)
const rogue = writers.filter(p => !(p in ALLOWED_WRITERS))
check('only the employee editor writes a technician row from the UI', rogue.length === 0,
  `also written by: ${rogue.join(', ')} — go through EmployeeEditor so a failed save can’t look saved`)
for (const [p, why] of Object.entries(ALLOWED_WRITERS)) {
  if (!writers.includes(p)) fail(`stale writer allowance: ${p}`, `${why} — but it no longer writes technicians; delete the entry`)
}

// The editor's own contract: controlled inputs, one explicit save, and a failure
// that KEEPS the dialog open with the reason on it.
const editor = read('src/components/workforce/EmployeeEditor.tsx')
check('the editor is controlled, not defaultValue+onBlur',
  !/defaultValue=/.test(editor) && /value=\{draft\./.test(editor),
  'uncontrolled fields cannot be corrected by a refetch — that was the original bug')
check('a failed save keeps the dialog open and says why',
  /if \(err\) \{[\s\S]{0,200}setError\(/.test(editor) && /return\s*\n\s*\}/.test(editor),
  'it must not close, and must not toast success, when the database refused')
check('the editor never re-seeds from a background refetch',
  /\[open, key\]/.test(editor),
  'keying the re-seed on the open+id (not the object) is what stops a refetch erasing typing')

// The dispatch modal must not grow a second one back.
const crewManager = read('src/components/dispatch/CrewManager.tsx')
check('the dispatch modal no longer edits people',
  !/from\('technicians'\)\.(update|insert)/.test(crewManager) && !crewManager.includes('archiveTechnician'),
  'crews and vehicles only — people are managed on Workforce')
check('…and it points at where they are managed',
  crewManager.includes('/dashboard/workforce'),
  'a read-only glance has to offer the way through')

// ── 7. Vocabulary ────────────────────────────────────────────────────────────
console.log('\n═══ Plain service-business language ═══')
check('the shared word is defined once', EMPLOYEE === 'employee')
// The DB name may stay; the SCREEN must not say it. Only RENDERED copy is
// checked — a JSX text node, or a user-facing attribute. Props, imports, type
// annotations and comments all legitimately say Technician, and an earlier
// version of this check matched every one of them because a bare `>` also ends
// a generic and a JSX tag.
const TEXT_NODE = />[^<>{}\n]*\bTechnicians?\b[^<>{}\n]*</i
const ATTR = /(?:label|title|placeholder|description|aria-label|confirmLabel)="[^"\n]*\bTechnicians?\b/i
for (const f of [
  { p: 'app/dashboard/workforce/page.tsx', t: workforce },
  { p: 'components/workforce/TeamPanel.tsx', t: read('src/components/workforce/TeamPanel.tsx') },
  { p: 'components/workforce/EmployeeEditor.tsx', t: editor },
  { p: 'components/dispatch/CrewManager.tsx', t: crewManager },
]) {
  const m = f.t.match(TEXT_NODE) || f.t.match(ATTR)
  check(`${f.p} says employee, not technician`, !m, `rendered copy still reads: ${m?.[0]?.replace(/\s+/g, ' ').slice(0, 70)}`)
}

// ── 8. What the owner actually reads ─────────────────────────────────────────
// The page is a client component, so a server request returns only the loading
// skeleton — you cannot see this list without a browser. Rendering the panel to
// static markup is the closest honest substitute, and it earned its place: the
// first run printed "New Start · No crew · No access · No crew · No wage",
// because the gap chips repeated what the crew chip and the access badge had
// already said. No type or lint rule would ever have caught that.
//
// Two mechanics worth knowing before editing this block:
//  • createElement rather than JSX here, because this file runs under the app's
//    tsconfig and `jsx: preserve` gives tsx no runtime to compile JSX against.
//  • the COMPONENT is full of JSX, and under that same setting it compiles to
//    bare `React.createElement(...)` with no import — the classic runtime, which
//    expects React in scope. Next supplies that; a plain tsx process does not.
//    So React goes on the global before the component is required.
console.log('\n═══ The rendered list ═══')
{
  const React = require('react') as typeof import('react')
  ;(globalThis as Record<string, unknown>).React = React
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
  const { TeamPanel } = require('../src/components/workforce/TeamPanel') as typeof import('../src/components/workforce/TeamPanel')

  const roster = [
    tech({ id: '1', name: 'Sam Torres', role: 'Crew lead', crew_id: 'c1', phone: '(587) 555-0134', hourly_wage: 28.5, auth_user_id: 'u1' }),
    tech({ id: '2', name: 'Jo Baker', crew_id: 'c2', hourly_wage: 24, auth_user_id: 'u2' }),
    tech({ id: '3', name: 'New Start' }),
    tech({ id: '4', name: 'Pat Quinn', is_active: false, crew_id: 'c1', hourly_wage: 26 }),
    tech({ id: '5', name: 'Old Hand', archived_at: '2026-02-01T00:00:00Z' }),
  ]
  const html = renderToStaticMarkup(React.createElement(TeamPanel, {
    technicians: roster, crews: CREWS,
    accessById: {
      '1': { linked: true, email: 'sam@x.co', last_sign_in_at: '2026-08-08T12:00:00Z' },
      '2': { linked: true, email: 'jo@x.co', last_sign_in_at: null },
    },
    onAdd: () => {}, onOpen: () => {},
  }))
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  check('the header counts active and inactive', /3 active · 1 inactive/.test(text), text.slice(0, 120))
  check('…and names what is still missing',
    /not on a crew/.test(text) && /with no wage/.test(text) && /without app access/.test(text))
  check('someone set up reads Active, with their crew',
    /Sam Torres[\s\S]{0,140}North crew[\s\S]{0,60}Active/.test(text))
  check('someone invited but not arrived reads Invite pending',
    /Jo Baker[\s\S]{0,140}Invite pending/.test(text))
  check('a half-added employee shows each gap exactly ONCE',
    /New Start[\s\S]{0,160}No crew[\s\S]{0,80}No access[\s\S]{0,60}No wage/.test(text)
    && (text.match(/No crew/g) || []).length === 1,
    'the crew chip and the access badge already say two of them — gap chips must not repeat them')
  check('inactive sit under their own heading', /Not working right now[\s\S]{0,220}Pat Quinn/.test(text))
  check('an inactive person never reads Active', /Pat Quinn[\s\S]{0,180}Disabled/.test(text))
  check('former are folded away, not deleted',
    /Show 1 former team member/.test(text) && !/Old Hand/.test(text))
  check('the word "technician" never reaches the screen', !/technician/i.test(text))
  // Ergonomics, asserted rather than eyeballed: the whole row is the target, and
  // no class depends on a breakpoint this Tailwind config does not define.
  check('every row is one full-width target', (html.match(/py-3 flex items-center gap-3/g) || []).length >= 4)
  check('no dead `xs:` breakpoint', !/\bxs:/.test(html),
    'this config defines no xs — such a class silently never applies')
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:team — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:team — one home, one editor, one vocabulary\n')
