// ── Verify: Crew Mode cannot become a client-side role check ─────────────────
//   npm run verify:crew-access
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote had exactly one authenticated account for its whole life. Crew Mode
// adds a second KIND of account to a codebase where ~300 RLS policies are the
// same line — `auth.uid() = user_id` — and where every table's `user_id` is the
// OWNER's. The safe way to add employees was to leave all of that alone and add
// narrow crew-only policies beside it; the unsafe way is the one that always
// gets written next, by someone in a hurry:
//
//   • gate a crew route on a boolean held in React
//   • let a crew screen read `customers` or `technicians` directly, which is
//     row-level and therefore hands over consent flags, notes, lifetime value
//     and every teammate's hourly wage
//   • let a crew screen write `jobs` with its own hand-rolled patch, which is
//     how price, schedule and crew assignment become field-editable
//   • drop `set search_path` from a SECURITY DEFINER function, which makes it
//     hijackable
//
// tsc and `next build` are perfectly happy with all four. So the ROUTING TABLE
// is asserted as behaviour, and the rest is asserted over the real source and
// the real migration.

import { routeFor, isOwnerPath, isCrewPath, isJoinPath, nextCrewStop, stopPrimaryAction, type AppRole, type CrewStop } from '../src/lib/crewAccess'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, actual: unknown, expected: unknown) =>
  check(n, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ── 1. The routing table, as behaviour ───────────────────────────────────────
console.log('\n═══ Who may be where ═══')

// Signed out: both private trees bounce to sign-in; nothing public is touched.
eq('signed out → /dashboard sends to /login', routeFor('none', '/dashboard', false), '/login')
eq('signed out → /crew sends to /login', routeFor('none', '/crew', false), '/login')
eq('signed out → /crew/join sends to /login', routeFor('none', '/crew/join', false), '/login')
eq('signed out → the customer portal is untouched', routeFor('none', '/portal/abc123', false), null)
eq('signed out → public booking is untouched', routeFor('none', '/book/abc123', false), null)

// A crew member never reaches the CRM. This is the line that matters most: every
// owner-only surface — quoting, invoices, payments, accounting, settings, the
// customer list — lives under /dashboard.
for (const p of ['/dashboard', '/dashboard/invoices', '/dashboard/payments', '/dashboard/quotes',
                 '/dashboard/accounting', '/dashboard/settings', '/dashboard/customers',
                 '/dashboard/dispatch/payroll', '/dashboard/schedule']) {
  eq(`crew → ${p} is redirected out`, routeFor('crew', p, true), '/crew')
}
eq('crew → /crew is allowed', routeFor('crew', '/crew', true), null)
eq('crew → /crew/schedule is allowed', routeFor('crew', '/crew/schedule', true), null)
eq('crew → /crew/profile is allowed', routeFor('crew', '/crew/profile', true), null)
eq('crew → /login goes to their own home', routeFor('crew', '/login', true), '/crew')

// The owner keeps everything, and is never demoted into Crew Mode.
for (const p of ['/dashboard', '/dashboard/invoices', '/dashboard/settings', '/dashboard/dispatch']) {
  eq(`owner → ${p} is untouched`, routeFor('owner', p, true), null)
}
eq('owner → /crew is sent back to the CRM', routeFor('owner', '/crew', true), '/dashboard')
eq('owner → /crew/join is sent back to the CRM', routeFor('owner', '/crew/join', true), '/dashboard')
eq('owner → /login goes to the CRM', routeFor('owner', '/login', true), '/dashboard')

// Signed in but linked to nobody: the ONE page they may see is the join form.
// Gating that behind a role would be a deadlock — it is how 'none' stops being
// 'none'.
eq('unlinked → /crew sends to the join form', routeFor('none', '/crew', true), '/crew/join')
eq('unlinked → /crew/join is allowed', routeFor('none', '/crew/join', true), null)
// …and /dashboard is deliberately NOT intercepted: a brand-new OWNER is also
// 'none' until /setup writes their business_settings row.
eq('unlinked → /dashboard is left to the first-run flow', routeFor('none', '/dashboard', true), null)

// Path classification can't drift into matching a prefix by accident.
check('path matching is segment-exact', !isCrewPath('/crewmate') && !isOwnerPath('/dashboards') && !isJoinPath('/crew/joinx'),
  '/crewmate, /dashboards and /crew/joinx must not be treated as crew/owner/join paths')
check('the crew tree is recognised', isCrewPath('/crew') && isCrewPath('/crew/profile') && isJoinPath('/crew/join'))

// ── 2. The next action a worker sees ─────────────────────────────────────────
console.log('\n═══ The one next action ═══')
const stop = (id: string, status: CrewStop['status']): CrewStop => ({
  id, title: id, service_type: null, scheduled_date: '2026-08-07', start_time: null,
  duration_minutes: 45, crew_size: 1, status, started_at: null, completed_at: null,
  actual_minutes: null, on_my_way_at: null, route_order: null, updated_at: 'v1',
  notes: null, customer: null, property: null,
})
eq('an on-the-clock visit outranks the queue',
  nextCrewStop([stop('a', 'scheduled'), stop('b', 'in_progress')])?.id, 'b')
eq('otherwise it is the first one still to do',
  nextCrewStop([stop('a', 'completed'), stop('b', 'scheduled'), stop('c', 'scheduled')])?.id, 'b')
eq('a finished day has no next action', nextCrewStop([stop('a', 'completed')]), undefined)
eq('the button starts a scheduled visit', stopPrimaryAction(stop('a', 'scheduled')), 'start')
eq('the button finishes a running one', stopPrimaryAction(stop('a', 'in_progress')), 'complete')
eq('no stop, no button', stopPrimaryAction(undefined), null)

// ── 3. The gates are server-side ─────────────────────────────────────────────
console.log('\n═══ Authorization is not a React prop ═══')

const middleware = read('src/lib/supabase/middleware.ts')
check('middleware asks the database for the role',
  middleware.includes('resolveAppRole') && middleware.includes('routeFor'),
  'the edge gate must resolve the role through lib/crewAccess, not read a cookie or a claim')

const crewLayout = read('src/app/crew/(app)/layout.tsx')
// The CALL, not the import: a layout that imports the resolver and then hard-codes
// a role reads exactly like a gated one and is not gated at all.
check('the crew shell re-checks on the server',
  /await resolveAppRole\(supabase\)/.test(crewLayout) && crewLayout.includes('redirect'),
  'middleware can be bypassed by a direct RSC request — the layout must call resolveAppRole itself')
check('the crew shell rejects owners and the unlinked',
  /role === 'owner'/.test(crewLayout) && /role !== 'crew'/.test(crewLayout))

check('resolveAppRole fails CLOSED',
  /if \(error\) return 'none'/.test(read('src/lib/crewAccess.ts')),
  'a failed role read must resolve to the least privilege, never to owner or crew')

// ── 4. Crew screens touch only what they are allowed to ──────────────────────
console.log('\n═══ What a crew screen may import and read ═══')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const crewFiles = [...walk(join(SRC, 'app', 'crew')), ...walk(join(SRC, 'components', 'crew'))]
  .map(p => ({ path: p.slice(SRC.length + 1).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))

check('the crew tree exists', crewFiles.length >= 5, `only ${crewFiles.length} crew files found`)

// The owner's money and CRM engines. A crew screen importing one of these is
// either about to render it or about to call it — both are the bug.
const OWNER_ONLY = [
  '@/lib/invoicing', '@/lib/payments', '@/lib/accounting', '@/lib/pricing', '@/lib/jobPricing',
  '@/lib/payroll', '@/lib/payRun', '@/lib/quotes', '@/lib/customers', '@/components/layout/Sidebar',
  '@/components/layout/BottomNav', '@/hooks/useModules',
]
for (const f of crewFiles) {
  const hit = OWNER_ONLY.find(m => f.text.includes(`from '${m}`))
  if (hit) fail(`${f.path} imports ${hit}`, 'Crew Mode must not reach the owner’s money/CRM engines or navigation')
}
if (!crewFiles.some(f => OWNER_ONLY.some(m => f.text.includes(`from '${m}`)))) {
  ok('no crew screen imports an owner-only engine')
}

// Tables a crew screen must never query directly: RLS is ROW-level, so a read of
// `customers` would carry consent + notes + lifetime value, and `technicians`
// would carry every teammate's wage. Those fields reach the phone only through
// crew_day(), which names its columns.
const FORBIDDEN_TABLES = ['customers', 'technicians', 'invoices', 'payments', 'quotes', 'business_settings', 'crews']
for (const f of crewFiles) {
  for (const t of FORBIDDEN_TABLES) {
    if (f.text.includes(`from('${t}')`)) {
      fail(`${f.path} queries ${t} directly`, 'read it through the crew_day RPC, which limits the columns — RLS cannot')
    }
  }
}
if (!crewFiles.some(f => FORBIDDEN_TABLES.some(t => f.text.includes(`from('${t}')`)))) {
  ok('no crew screen queries an owner table directly')
}

// `jobs` included: a crew session has NO table grants at all, so even the one
// table they conceptually own is reached through an RPC.
for (const f of crewFiles) {
  if (f.text.includes(".from('jobs')")) {
    fail(`${f.path} touches the jobs table directly`, 'go through lib/crewJob — a crew session has no table grants, only RPCs')
  }
}
const crewJob = read('src/lib/crewJob.ts')
check('crew completion reuses the canonical stamp',
  crewJob.includes('completionPatch') && crewJob.includes("from '@/lib/jobStatus'"),
  'a crew "done" must write the same row an owner "done" writes — see verify:job-completion')
check('the crew write goes through the typed RPC, not a patch object',
  crewJob.includes("rpc('crew_set_visit_status'") && !crewJob.includes(".from('jobs')"),
  'typed parameters are what stop a client smuggling price or scheduled_date into the write')
check('crew writes are version-guarded and checked',
  /p_base_updated_at: stop\.updated_at/.test(crewJob) && /if \(error\)/.test(crewJob) && /!res\?\.ok/.test(crewJob),
  'an unchecked crew write is a worker driving away from a job the server never marked done')
check('a crew start preserves banked minutes',
  /status: 'in_progress'[\s\S]{0,160}actual_minutes: stop\.actual_minutes/.test(crewJob),
  'checking in must not clear time banked by an earlier day’s session (see continueJobAnotherDay)')

// ── 5. The migration says what the code assumes ──────────────────────────────
console.log('\n═══ The database is the boundary ═══')

const sql = read('supabase/RUN-2026-08-07-crew-mode.sql')

check('no owner policy is dropped',
  !/drop policy[^\n]*(select own|update own|insert own|delete own)/i.test(sql),
  'the four `auth.uid() = user_id` policies per table are the owner’s access; this migration must never touch them')

// ⭐ The decision the whole design turns on: RLS is row-level, so ANY crew policy
// on jobs also hands over `price`. A crew session must have no table grants.
check('the migration grants crew NO table policy',
  /drop policy if exists "jobs: crew reads assigned"/.test(sql)
  && /drop policy if exists "jobs: crew updates assigned"/.test(sql)
  && !/create policy[^\n]*crew/i.test(sql),
  'a crew RLS policy on jobs would expose every column of those rows, price included — read through crew_day, write through crew_set_visit_status')

check('the crew write RPC takes typed parameters',
  /function public\.crew_set_visit_status\(\s*\n?\s*p_job_id\s+uuid/.test(sql)
  && !/p_patch\s+jsonb/.test(sql),
  'a jsonb patch parameter would let a client name any column')
check('the crew write RPC re-checks the assignment and the row version',
  /crew_set_visit_status[\s\S]{0,2200}j\.user_id = v_employer[\s\S]{0,120}j\.crew_id = v_crew[\s\S]{0,120}j\.updated_at = p_base_updated_at/.test(sql),
  'it is SECURITY DEFINER, so it runs past the RLS that would otherwise check who is asking')
check('the crew write RPC refuses a cancel',
  /crew_set_visit_status[\s\S]{0,1200}p_status not in \('scheduled', 'in_progress', 'completed'\)/.test(sql))

check('a BEFORE UPDATE guard pins the writable columns',
  /create trigger crew_job_field_guard[\s\S]{0,200}before update on public\.jobs/i.test(sql),
  'RLS chooses rows, not columns — the trigger is the only thing stopping a crew price edit')
check('the guard lets the owner and the service role straight through',
  /auth\.uid\(\) is null or auth\.uid\(\) = new\.user_id/.test(sql),
  'this trigger fires on EVERY jobs update; it must be incapable of raising on the owner’s path')
for (const col of ['price', 'scheduled_date', 'crew_id', 'notes', 'customer_id']) {
  check(`the guard protects ${col}`, new RegExp(`new\\.${col}[,)]`).test(sql))
}

// Every DEFINER function must pin its search_path — an unpinned one runs the
// definer's privileges against whatever schema the caller points it at.
const definers = [...sql.matchAll(/create or replace function (public\.\w+)\(([^)]*)\)([\s\S]*?)\bas \$fn\$/g)]
  .concat([...sql.matchAll(/create or replace function (public\.\w+)\(([^)]*)\)([\s\S]*?)\bas \$\$/g)])
check('the migration defines the crew functions', definers.length >= 8, `found ${definers.length}`)
for (const [, name, , head] of definers) {
  if (!/security definer/i.test(head)) continue
  check(`${name} pins its search_path`, /set search_path/i.test(head),
    'a SECURITY DEFINER function without a pinned search_path is hijackable')
}

// The read RPC is the column allow-list. If wages or prices appear in it, the
// whole reason it exists instead of an RLS policy has been undone.
const crewDayBody = sql.slice(sql.indexOf('function public.crew_day'), sql.indexOf('function public.crew_upcoming'))
check('crew_day never returns a wage', !/hourly_wage/.test(crewDayBody),
  'teammates come back as name + role only')
check('crew_day never returns a price', !/j\.price|'price'/.test(crewDayBody),
  'money is the owner’s; a worker is shown the work')
check('crew_day fails closed for a non-member', /if v_employer is null then\s*\n\s*return null;/.test(crewDayBody),
  'a revoked employee must get NULL — distinguishable from a day with no stops')

// Deactivation must be re-checked per query, not trusted from a session.
check('every identity helper requires an ACTIVE, unarchived roster row',
  (sql.match(/t\.is_active\s*\n?\s*and t\.archived_at is null/g) || []).length >= 3,
  'crew_employer / crew_technician_id / crew_crew_id must each re-check the roster switches')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:crew-access — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:crew-access — owners keep everything, crew get their own work only\n')
