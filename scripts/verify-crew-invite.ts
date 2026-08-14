// ── Verify: provisioning a login cannot leak, and cannot bind the wrong person ─
//   npm run verify:crew-invite
//
// WHY THIS SCRIPT EXISTS
// Crew Mode's data boundary is RPC-only and proven (verify:crew-access). This
// feature adds the one thing that boundary deliberately did not have: a code
// path holding the SERVICE ROLE, which bypasses RLS entirely. Three ways that
// goes wrong, none of which tsc or `next build` will notice:
//
//   • the admin client drifts into a file that ships to the browser, or the key
//     name appears in client code — the credential is then in a bundle, forever;
//   • the ownership check moves after the admin client is constructed, or is
//     replaced by a body field, so anyone signed in can provision on anyone's
//     roster;
//   • a collision case loses its refusal, and an invite silently re-points an
//     employee at a different account (or hands somebody else's login to them).
//
// So the state machine is asserted as behaviour, and the rest is asserted over
// the real route, the real client tree and the real migration.

import {
  crewAccessState, accessFacts, normalizeInviteEmail, isPlausibleEmail,
  buildSetupUrl, CREW_WELCOME_PATH, CREW_ACCESS_LABEL,
} from '../src/lib/crewInvite'
import { routeFor } from '../src/lib/crewAccess'
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

// ── 1. The four states ───────────────────────────────────────────────────────
console.log('\n═══ What the roster badge says ═══')

const F = (o: Partial<Parameters<typeof crewAccessState>[0]>) =>
  crewAccessState({ isActive: true, linked: false, ...o })

eq('nobody invited yet → No access', F({}), 'none')
eq('linked and has signed in → Active', F({ linked: true, lastSignInAt: '2026-08-09T10:00:00Z' }), 'active')
eq('linked but never arrived → Invite pending', F({ linked: true, lastSignInAt: null }), 'invited')
eq('a live join code outstanding → Invite pending', F({ hasCode: true }), 'invited')
eq('a link was sent but not accepted → Invite pending', F({ inviteSentAt: '2026-08-09T09:00:00Z' }), 'invited')

// ⭐ Disabled OUTRANKS everything. Showing "Active" for somebody the roster
// switch has already locked out is the one genuinely misleading answer this
// badge could give — they cannot get in, whatever the link says.
eq('switched inactive beats Active', F({ isActive: false, linked: true, lastSignInAt: '2026-08-09T10:00:00Z' }), 'disabled')
eq('switched inactive beats Invite pending', F({ isActive: false, linked: true }), 'disabled')
eq('switched inactive beats No access', F({ isActive: false }), 'disabled')

// accessFacts is what the UI actually feeds it — archived must read as disabled
// too, since archived_at cuts access in exactly the same way is_active does.
eq('archived reads as disabled',
  crewAccessState(accessFacts({ is_active: true, archived_at: '2026-08-01T00:00:00Z', auth_user_id: 'u1' }, null)), 'disabled')
eq('active + linked + signed in, through accessFacts',
  crewAccessState(accessFacts({ is_active: true, archived_at: null, auth_user_id: 'u1' }, { linked: true, email: 'a@b.co', last_sign_in_at: '2026-08-09T10:00:00Z' })), 'active')
check('every state has a label', Object.keys(CREW_ACCESS_LABEL).length === 4)

// ── 2. Email + the setup link ────────────────────────────────────────────────
console.log('\n═══ The address and the link ═══')
eq('email is normalised once', normalizeInviteEmail('  Sam@Example.COM '), 'sam@example.com')
check('a typo is caught before the round trip', !isPlausibleEmail('sam@example') && !isPlausibleEmail('sam.example.com') && !isPlausibleEmail(''))
check('a real address passes', isPlausibleEmail('sam.torres@edgeproperty.ca'))

const url = buildSetupUrl('https://app.example.com/', 'abc/def+ghi=')
eq('the link points at the welcome page', url.startsWith('https://app.example.com' + CREW_WELCOME_PATH + '?token='), true)
check('a trailing slash on the origin does not double up', !url.includes('.com//'))
check('the token is URL-encoded', url.includes('abc%2Fdef%2Bghi%3D'),
  'an un-encoded token breaks the moment Supabase mints one containing / or +')

// The welcome page must be reachable with NO session — the employee arrives
// holding a token and nothing else. A gate that bounced them to /login would
// make an owner-provisioned invite impossible to accept.
eq('signed out → /crew/welcome is allowed', routeFor('none', '/crew/welcome', false), null)
eq('signed in but unlinked → /crew/welcome is allowed', routeFor('none', '/crew/welcome', true), null)
eq('crew → /crew/welcome is allowed', routeFor('crew', '/crew/welcome', true), null)
eq('owner → /crew/welcome is allowed', routeFor('owner', '/crew/welcome', true), null)
// …and nothing else about the gate moved.
eq('crew still cannot reach the CRM', routeFor('crew', '/dashboard/invoices', true), '/crew')
eq('signed out still cannot reach /crew', routeFor('none', '/crew', false), '/login')

// ── 3. The service role never reaches the browser ────────────────────────────
console.log('\n═══ Admin credentials stay on the server ═══')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const files = walk(SRC).map(p => ({
  path: p.slice(SRC.length + 1).replace(/\\/g, '/'),
  text: readFileSync(p, 'utf8'),
}))
check('the source scan found the app', files.length > 200, `only ${files.length} files walked`)

// A 'use client' file is compiled into the browser bundle. Neither the admin
// client nor the key's NAME may appear in one — the name is how the value gets
// there next.
const clientFiles = files.filter(f => /^['"]use client['"]/m.test(f.text))
check('there are client components to check', clientFiles.length > 50, `only ${clientFiles.length} found`)
for (const f of clientFiles) {
  if (f.text.includes('createAdminClient')) fail(`${f.path} imports createAdminClient`, 'that constructs a service-role client — it must never be in a browser bundle')
  if (f.text.includes('SUPABASE_SERVICE_ROLE_KEY')) fail(`${f.path} names SUPABASE_SERVICE_ROLE_KEY`, 'a client component must not reference the service key, even to test for it')
}
if (!clientFiles.some(f => f.text.includes('createAdminClient') || f.text.includes('SUPABASE_SERVICE_ROLE_KEY'))) {
  ok('no client component touches the service role')
}

// Where the key may be NAMED at all. Two dozen server routes read it directly
// (cron guards, the Stripe webhook, the comms senders) and that predates this
// feature — the rule worth enforcing is not "one reader" but "server only".
// `src/components/**` is the tree that exists to be rendered, so a mention there
// is a mistake even in a file that forgot its 'use client' directive.
const keyReaders = files.filter(f => f.text.includes('SUPABASE_SERVICE_ROLE_KEY')).map(f => f.path)
check('the key is read somewhere (the scan works)', keyReaders.length > 0)
const misplaced = keyReaders.filter(p => !(p.startsWith('app/api/') || p.startsWith('lib/')))
check('the key is named only in server code', misplaced.length === 0,
  `named in: ${misplaced.join(', ')} — only app/api/** and lib/** may reference it`)

// Everything that constructs one must be server-only.
for (const f of files) {
  if (f.path === 'lib/supabase/admin.ts') continue
  if (!f.text.includes('createAdminClient')) continue
  const serverOnly = f.path.startsWith('app/api/') || f.path.startsWith('lib/')
  check(`${f.path} is server-only`, serverOnly, 'createAdminClient may only be used from an API route or a server lib')
}

// ── 4. The invite route's own shape ──────────────────────────────────────────
console.log('\n═══ /api/crew/invite ═══')
const route = read('src/app/api/crew/invite/route.ts')

check('it pins the Node runtime',
  /export const runtime = 'nodejs'/.test(route),
  'the service role must never be handed to the edge runtime')

// ⭐ ORDER MATTERS. Authorization has to be settled before a credential that
// bypasses RLS is even constructed.
//
// Comments are stripped first. This file explains itself at length, and a
// mention of `createAdminClient()` in the header would otherwise read as a call
// site — the check would then measure the prose, not the code. (Caught by this
// guard failing on its own subject the first time it ran.)
const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const iRole = code.indexOf('resolveAppRole(supabase)')
const iOwn = code.indexOf(".from('technicians')")
const iAdmin = code.indexOf('createAdminClient()')
check('the owner check runs before the admin client is built', iRole > 0 && iAdmin > iRole,
  'resolveAppRole must gate the request before any service-role client exists')
check('ownership is proved before the admin client is built', iOwn > 0 && iAdmin > iOwn,
  'the technician must be read through the CALLER’s RLS-scoped client first')
check('the role comes from the database, not the request',
  /resolveAppRole\(supabase\)/.test(route) && !/body\?\.(role|isOwner)/.test(route))
check('ownership is proved by RLS, not by an if',
  /supabase\s*\n?\s*\.from\('technicians'\)/.test(route),
  'read the row with the caller’s own client — RLS returns nothing for a foreign roster')
check('the admin write is also scoped to the owner',
  /\.eq\('id', tech\.id\)\s*\n?\s*\.eq\('user_id', user\.id\)/.test(route),
  'the privileged update must not be able to land on a foreign row even if the check above were removed')

// Every refusal the brief asks to be proven, present by name.
for (const reason of ['own-account', 'email-taken', 'already-linked', 'archived', 'inactive', 'bad-email', 'not-configured', 'not-your-technician']) {
  check(`it refuses: ${reason}`, route.includes(`'${reason}'`), `no branch returns ${reason}`)
}
check('a missing key degrades with a named next step',
  /SUPABASE_SERVICE_ROLE_KEY/.test(route) && /Join code/i.test(route),
  'when the key is absent, say which variable is missing AND that the code path still works')

// The setup URL is a credential for the minutes it lives.
check('nothing logs the setup link or the token',
  !/console\.(log|info|warn|error)/.test(route),
  'a logged setup link is a login sitting in a log aggregator')

// A found account is only reused when the scan actually completed — otherwise a
// paging failure reads as "no such user" and creates a DUPLICATE account.
check('an incomplete account scan is an error, not a miss',
  /scanComplete/.test(route),
  'bailing out of the page walk must not be indistinguishable from “no existing user”')

// ── 5. The migration keeps the boundary ──────────────────────────────────────
console.log('\n═══ The RPC-only crew boundary is untouched ═══')
const sql = read('supabase/archive/run/RUN-2026-08-09-crew-invite.sql')
check('no crew RLS policy is introduced', !/create policy[^\n]*crew/i.test(sql),
  'crew data access stays RPC-only — see verify:crew-access')
check('no owner policy is dropped', !/drop policy[^\n]*(select own|update own|insert own|delete own)/i.test(sql))
check('crew_access_states is owner-scoped',
  /crew_access_states[\s\S]{0,1400}t\.user_id = auth\.uid\(\)/.test(sql)
  && /crew_access_states[\s\S]{0,1400}business_settings b where b\.user_id = auth\.uid\(\)/.test(sql),
  'it reads auth.users emails — a crew member calling it must get nothing')
check('crew_access_states pins its search_path',
  /crew_access_states[\s\S]{0,400}set search_path/.test(sql))
check('it is not executable by anon',
  /revoke execute on function public\.crew_access_states\(\) from public, anon/.test(sql))
check('revoking access also forgets the invite',
  /crew_revoke_access[\s\S]{0,1200}invite_sent_at = null/.test(sql),
  'otherwise the roster keeps claiming a link was sent to somebody who has no access')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:crew-invite — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:crew-invite — the owner provisions, the key stays server-side\n')
