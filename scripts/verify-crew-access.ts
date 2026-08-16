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

import { routeFor, isOwnerPath, isCrewPath, isJoinPath, nextCrewStop, partitionCrewStops, stopPrimaryAction, type AppRole, type CrewStop } from '../src/lib/crewAccess'
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
  notes: null, completion_summary: null, completion_issue: null, customer: null, property: null,
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
// ⚠️ COMMENTS ARE STRIPPED BEFORE ANY OF THE SCANS BELOW, and that is not a
// nicety. A crew file that DOCUMENTS the rule — "there is deliberately no
// `.from('crew_messages')` in this tree" — contains the exact string these
// scans look for, so a raw-text grep reports the WARNING as the BREACH: the
// cure read as the disease. Caught for real on 2026-08-13 by
// CrewStopConversation.tsx, whose header explains the rule it obeys.
// `[^\n\r]` rather than `.*$`: on a CRLF checkout `.` does not match `\r`, so
// `.*$` strips nothing and every scan below quietly starts reading comments
// again. (The same stripper, and the same reasoning, as verify:scoped-notes.)
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')
const crewFiles = [...walk(join(SRC, 'app', 'crew')), ...walk(join(SRC, 'components', 'crew'))]
  .map(p => ({ path: p.slice(SRC.length + 1).replace(/\\/g, '/'), text: stripComments(readFileSync(p, 'utf8')) }))

// MECHANISM CONTROL on the stripper: if it ever became a no-op (the CRLF
// failure), these scans would silently start matching prose again — and if it
// over-stripped, they would match nothing at all and pass for the wrong reason.
check('the comment stripper works, and keeps real code',
  !stripComments("const a = 1\r\n// from('customers')\r\n").includes("from('customers')") &&
  stripComments("supabase.from('customers') // note").includes("from('customers')"),
  'every table/import scan below is worthless if this is wrong in either direction')

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
// crew_messages / crew_message_reads added 2026-08-13: a crew session has no
// grants on them either, so a direct read would return an EMPTY conversation
// rather than an error — the worst possible failure, because it looks like
// "nobody said anything" instead of "you cannot see this". The conversation
// reaches the phone only through crew_job_messages/crew_post_message.
const FORBIDDEN_TABLES = ['customers', 'technicians', 'invoices', 'payments', 'quotes', 'business_settings', 'crews',
  'crew_messages', 'crew_message_reads']
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

const sql = read('supabase/archive/run/RUN-2026-08-07-crew-mode.sql')

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

// ── The workday contracts (2026-08-09 pass) ──────────────────────────────────
console.log('\n═══ The workday is honest and complete ═══')

// The manager's instructions reach the worker. dispatch_notes is the box the
// dispatch board labels "gate codes, yard reminders, weather calls" — until this
// pass it rendered only on the owner's board, the one screen a worker can't open.
check('crew_day carries the office day note', /'day_note'/.test(crewDayBody),
  'the dispatch day note never reaches the worker without it')
check('crew_day carries the crew note', /'crew_note'/.test(crewDayBody),
  'the crew-specific gate codes never reach the worker without it')
check('…and reads only the note BODY from dispatch_notes',
  (crewDayBody.match(/from public\.dispatch_notes/g) || []).length === 2 &&
  (crewDayBody.match(/select d\.body from public\.dispatch_notes/g) || []).length === 2,
  'the notes subqueries must project body only')

// Dead signal is not a firing notice. supabase-js RESOLVES with { error } on a
// dead connection, so "couldn't ask" and "the DB answered null" arrive as
// different fields — the seam must keep three outcomes apart, and the Today
// screen may show "access turned off" ONLY for the revoked kind.
const ACCESS = read('src/lib/crewAccess.ts')
check('loadCrewDay reports error / revoked / ok as distinct outcomes',
  /if \(error\) return \{ kind: 'error'/.test(ACCESS) && /if \(!data\) return \{ kind: 'revoked' \}/.test(ACCESS),
  'folding error into null is how a worker in a dead zone gets told they were fired')
check('loadCrewUpcoming keeps the same three outcomes',
  (ACCESS.match(/kind: 'error', message: error\.message/g) || []).length >= 2)
const TODAY_SRC = read('src/components/crew/CrewToday.tsx')
check('CrewToday shows revoked ONLY for the revoked kind',
  /res\.kind === 'revoked'/.test(TODAY_SRC) && !/data === null[\s\S]{0,120}setRevoked\(true\)/.test(TODAY_SRC))
check('a failed REFRESH keeps the day on screen and says stale',
  /staleAsOf/.test(TODAY_SRC) && /dayRef\.current\) setStaleAsOf/.test(TODAY_SRC),
  'a refresh error must neither clear the board nor pose as current')

// The board self-heals without realtime (a crew session has no table access, and
// postgres_changes needs it): foreground return, connection return, slow tick.
check('CrewToday refetches when the tab returns / signal returns',
  /addEventListener\('online'/.test(TODAY_SRC) && /addEventListener\('visibilitychange'/.test(TODAY_SRC),
  'a phone left open in the truck must not show the morning’s board all day')

// ── Crew photos: verify-then-derive, never trust the client ──────────────────
console.log('\n═══ A worker’s photo files under the owner, for the verified job only ═══')
const PHOTO_ROUTE = 'src/app/api/crew/photos/route.ts'
check('the crew photo route exists', existsSync(join(ROOT, PHOTO_ROUTE)))
if (existsSync(join(ROOT, PHOTO_ROUTE))) {
  const R = read(PHOTO_ROUTE)
  check('the route requires the crew role from the DATABASE',
    /resolveAppRole/.test(R) && /role !== 'crew'/.test(R))
  check('the technician is resolved by the roster switches',
    /\.eq\('auth_user_id', user\.id\)\.eq\('is_active', true\)\.is\('archived_at', null\)/.test(R),
    'a deactivated worker must fail here mid-shift, unexpired JWT and all')
  check('the job is proven to belong to this worker’s employer AND crew',
    /\.eq\('id', jobId\)\.eq\('user_id', t\.user_id\)\.eq\('crew_id', t\.crew_id\)/.test(R))
  check('a cancelled visit takes no photos', /\.neq\('status', 'cancelled'\)/.test(R))
  check('photo identity comes from the VERIFIED JOB ROW, never the form',
    /user_id: j\.user_id/.test(R) && /customer_id: j\.customer_id/.test(R) && /property_id: j\.property_id/.test(R) &&
    !/form\.get\('customerId'\)/.test(R) && !/form\.get\('propertyId'\)/.test(R) && !/form\.get\('userId'\)/.test(R),
    'a crafted customer/property/user id in the form data must have nowhere to go')
  check('kind is whitelisted and the size is capped',
    // Since Job Forms V1 the whitelist is context-dependent: before/after for
    // the plain capture, +general ONLY when a checklist field is named. The
    // gating itself is pinned by verify:job-forms.
    /\(formId \? FORM_KINDS : KINDS\)\.has\(kind\)/.test(R) && /file\.size > MAX_BYTES/.test(R))
  check('a failed catalogue insert rolls the stored file back',
    /storage\.from\(PHOTO_BUCKET\)\.remove\(\[path\]\)/.test(R),
    'storage must never drift from the catalogue (uploadPhoto’s own rule)')
  check('no service key → the door stays shut',
    /if \(!admin\) return/.test(R), 'never fall back to a weaker check')
  check('a failed technician/job read refuses, never guesses',
    /if \(techErr\) return/.test(R) && /if \(jobErr\) return/.test(R),
    '"couldn’t check" must never be treated as "checked out fine"')
}
const CAPTURE = read('src/components/crew/CrewStopPhotos.tsx')
check('the capture UI never claims an upload the server didn’t confirm',
  /if \(!res\.ok \|\| !d\.ok\) throw/.test(CAPTURE) && /state: 'failed'/.test(CAPTURE),
  'a failed shot must turn into a visible Retry, not a quiet success')

// ── Cancelled work is told, not vanished (2026-08-09 clarity pass) ──────────
console.log('\n═══ A cancelled stop moves to a visible line — it never silently vanishes ═══')

// crew_day now RETURNS cancelled stops for the day (the server's own record of
// the change — no client "what was seen" memory to drift)…
check('crew_day no longer filters cancelled out of the day',
  !/status <> 'cancelled'/.test(crewDayBody),
  'a stop cancelled mid-morning must move to the cancelled line, not disappear between refetches')
// …while the Week counts still count only real work.
const crewUpcomingBody = sql.slice(sql.indexOf('function public.crew_upcoming'), sql.indexOf('function public.crew_set_visit_status'))
check('crew_upcoming still excludes cancelled (Week counts real work)',
  /status <> 'cancelled'/.test(crewUpcomingBody))

// The partition is the ONE rule for which side a stop is on, and the type
// system proves a cancelled stop can't reach Start/Finish or the camera.
const mk = (id: string, status: CrewStop['status'], order: number): CrewStop => ({
  id, title: id, service_type: null, scheduled_date: '2026-08-09', start_time: null,
  duration_minutes: 30, crew_size: 1, status, started_at: null, completed_at: null,
  actual_minutes: null, on_my_way_at: null, route_order: order, updated_at: 'v1', notes: null,
  completion_summary: null, completion_issue: null,
  customer: null, property: null,
})
// (No bare block after the arrow-object above: `=> ({…})` followed by `{` is an
// ASI trap tsc re-parses catastrophically while esbuild shrugs — unique names
// instead of a scope.)
const dayStops = [mk('a', 'cancelled', 1), mk('b', 'scheduled', 2), mk('c', 'completed', 3), mk('d', 'cancelled', 4)]
const daySplit = partitionCrewStops(dayStops)
check('partitionCrewStops splits exactly on status',
  daySplit.active.map(s => s.id).join() === 'b,c' && daySplit.cancelled.map(s => s.id).join() === 'a,d')
check('a cancelled stop is never the next stop — even listed first',
  nextCrewStop(dayStops)?.id === 'b',
  'the one big button must never name work the office pulled')
const allCancelledDay = partitionCrewStops([mk('x', 'cancelled', 1)])
check('a fully-cancelled day has zero active work', allCancelledDay.active.length === 0 && allCancelledDay.cancelled.length === 1)

// Today renders the split honestly: counts from active, a compact struck-through
// cancelled group, and a distinct empty-state when the whole day was pulled.
const TODAY_SRC2 = read('src/components/crew/CrewToday.tsx')
check('Today counts progress over ACTIVE stops only',
  /active\.length - done\} of \$\{active\.length\}/.test(TODAY_SRC2))
check('Today shows the cancelled line', /Cancelled today — don’t go/.test(TODAY_SRC2))
check('“everything cancelled” reads differently from “nothing assigned”',
  /Nothing left to do today/.test(TODAY_SRC2) && /No stops on the board/.test(TODAY_SRC2))
check('cancelled rows get no photos and no actions',
  !/cancelled\.map\([\s\S]{0,400}(CrewStopPhotos|act\()/.test(TODAY_SRC2))

// The Week page orients first-time eyes: today and tomorrow always present.
const WEEK_SRC = read('src/app/crew/(app)/schedule/page.tsx')
check('Week pins today and tomorrow even when empty', /x\.row \|\| x\.i < 2/.test(WEEK_SRC),
  '"am I working tomorrow" must never be answered by an absent row')
const WEEKDAY_SRC = read('src/components/crew/CrewWeekDay.tsx')
check('a Week day expands to a READ-ONLY preview (no Start on future days)',
  /loadCrewDay/.test(WEEKDAY_SRC) && !/crewStartVisit|crewCompleteVisit/.test(WEEKDAY_SRC))
check('a failed day preview says so — never an empty believable day',
  /detailFailed/.test(WEEKDAY_SRC) && /Couldn’t load this day/.test(WEEKDAY_SRC))

// ── Completion → billing handoff (2026-08-09) ───────────────────────────────
console.log('\n═══ Finished work bills the same no matter who pressed Complete ═══')

const CREWJOB = read('src/lib/crewJob.ts')
check('crew completion goes through /api/crew/complete, never the bare RPC',
  /crewCompleteVisit[\s\S]{0,900}fetch\('\/api\/crew\/complete'/.test(CREWJOB),
  'a bare-RPC completion silently skips the draft-invoice handoff the owner path always runs')
check('…and the stamp is still completionPatch (one definition of done, every door)',
  /crewCompleteVisit[\s\S]{0,500}completionPatch\(stop\)/.test(CREWJOB))
check('undoing a completion has its own door (the draft must die with the status)',
  /crewUncompleteVisit[\s\S]{0,600}action: 'undo'/.test(CREWJOB))
check('CrewToday picks the completion-undo for a completed visit',
  /kind === 'complete'\s*\n?\s*\? await crewUncompleteVisit/.test(read('src/components/crew/CrewToday.tsx')))

const COMPLETE_ROUTE = 'src/app/api/crew/complete/route.ts'
check('the completion route exists', existsSync(join(ROOT, COMPLETE_ROUTE)))
if (existsSync(join(ROOT, COMPLETE_ROUTE))) {
  const R = read(COMPLETE_ROUTE)
  check('the route requires the crew role from the DATABASE',
    /resolveAppRole/.test(R) && /role !== 'crew'/.test(R))
  check('the worker is resolved by the roster switches',
    /\.eq\('auth_user_id', user\.id\)\.eq\('is_active', true\)\.is\('archived_at', null\)/.test(R))
  check('the visit is proven to belong to this worker’s employer AND crew, and not cancelled',
    /\.eq\('id', jobId\)\.eq\('user_id', t\.user_id\)\.eq\('crew_id', t\.crew_id\)/.test(R) && /\.neq\('status', 'cancelled'\)/.test(R))
  check('the owner’s identity comes ONLY from the verified roster row',
    /const ownerId = t\.user_id/.test(R) &&
    !/body\??\.\w*[Oo]wner/.test(R) && !/body\??\.\w*[Aa]mount/.test(R) && !/body\??\.\w*[Cc]ustomer/.test(R),
    'a crafted owner/customer/amount in the body must have nowhere to go')
  check('the status write STILL goes through the crew RPC on the CALLER’s session',
    /supabase\.rpc\('crew_set_visit_status'/.test(R),
    'the typed-parameter door (assignment + version re-check, refuses cancelled) must stay the only status writer')
  check('the draft runs only AFTER the RPC confirmed the completion',
    R.indexOf("rpc('crew_set_visit_status'") < R.indexOf('await createDraftInvoiceForCompletedJob('))
  check('billing reuses THE engines — draft + AutoPay, no copies',
    /createDraftInvoiceForCompletedJob\(admin, freshRow as Job, \{ ownerId \}\)/.test(R) &&
    /attemptAutoPayCharge\(admin, \{ invoiceId: draft\.invoiceId, userId: ownerId, manual: false \}\)/.test(R))
  check('the engine drafts from a RE-READ row, never a hand-assembled echo of the request',
    /from\('jobs'\)\s*\n?\s*\.select\('\*'\)\.eq\('id', jobId\)\.eq\('user_id', ownerId\)/.test(R),
    'drafting from client-echoed fields would let a stale or crafted body shape the invoice context')
  check('AutoPay fires ONLY on a freshly-created draft',
    /if \(draft\.created && draft\.invoiceId\)/.test(R),
    "'exists' must never re-charge; a retried completion is a no-op")
  check('a failed draft notifies the OWNER — never silently, never the worker',
    /crew_complete_uninvoiced/.test(R) && /notifyOwner/.test(R))
  check('undo runs uncompleteJob (draft dies FIRST, status second, sent/paid left alone)',
    /uncompleteJob\(admin,/.test(R))
  check('an already-sent invoice on un-done work notifies the owner',
    /invoiceLocked/.test(R) && /crew_uncomplete_invoiced/.test(R))
  check('owner notifications dedupe per (type, job) — retries stack no bells',
    /\.eq\('type', p\.type\)\.eq\('entity_id', p\.jobId\)/.test(R))
}

// The engine’s new ownerId parameter is server-derivation only; every
// owner-session caller keeps the getUser() default unchanged.
const INVOICING = read('src/lib/invoicing.ts')
check('the engine’s ownerId override falls back to getUser (owner callers unchanged)',
  /opts\?\.ownerId \?\? null/.test(INVOICING) && /if \(!ownerId\) \{[\s\S]{0,200}auth\.getUser\(\)/.test(INVOICING))
check('no owner-path call site passes ownerId',
  !/createDraftInvoiceForCompletedJob\(supabase, [^)]*ownerId/.test(read('src/lib/jobStatus.ts')) &&
  !/createDraftInvoiceForCompletedJob\([^)]*ownerId/.test(read('src/lib/offline/handlers.ts')))

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:crew-access — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:crew-access — owners keep everything, crew get their own work only\n')
