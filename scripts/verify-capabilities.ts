// ── verify-capabilities — a beta tenant cannot reach another business's money or senders ──
//
//   npm run verify:capabilities
//
// WHY THIS EXISTS
// The deployment has ONE Stripe account, ONE Twilio number and ONE Resend
// identity, all belonging to the founding business. Session 43 introduced
// `platform_capabilities` (platform-managed grants; missing row = nothing) and
// gated every door that touches the shared infrastructure. The failure mode this
// guard pins is QUIET REGROWTH: one new send call-site that skips the gate, one
// payment door that forgets the check, one webhook edit that reaches back for
// the global phone resolver — and a private-beta business is charging customers
// into someone else's Stripe balance or texting from someone else's number.
//
// Three layers, mirroring how the restriction is built:
//   1. THE CONTRACT FILE — supabase/RUN-2026-08-13-platform-capabilities.sql is
//      the applied DDL; its load-bearing lines must not drift.
//   2. THE CODE — every payment door consults tenantCapabilities; the inbound
//      webhook uses the capability-scoped resolver; sendSms/sendEmail are
//      imported ONLY by the audited call-sites.
//   3. THE LIVE POSTURE (when credentials exist) — anon cannot read grants or
//      execute either phone resolver; a signed-in business cannot grant itself
//      a capability; the fixture tenant holds no grants.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadEnvLocal, openFixtureTenant, isSkipped } from './lib/verify-fixture'

const ROOT = join(__dirname, '..')
let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
// CRLF checkouts must not disarm these pins — normalise before matching.
function read(p: string): string { return readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') }

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE CONTRACT FILE — the applied DDL says what the table and resolver are')

const sql = read('supabase/archive/run/RUN-2026-08-13-platform-capabilities.sql')
check('grants table exists with all four capability columns',
  sql.includes('create table if not exists public.platform_capabilities')
  && ['online_payments', 'inbound_sms', 'outbound_sms', 'outbound_email']
    .every(c => sql.includes(`${c} boolean not null default false`)),
  'every capability must DEFAULT FALSE — a missing column default is a granted-by-accident beta tenant')
check('RLS on, and SELECT-own is the ONLY policy verb in the file',
  sql.includes('alter table public.platform_capabilities enable row level security')
  && sql.includes('for select to authenticated using (user_id = auth.uid())')
  && !/for (insert|update|delete|all)/.test(sql))
check('table privileges revoked from anon+authenticated, SELECT granted back alone',
  sql.includes('revoke all on table public.platform_capabilities from anon, authenticated')
  && sql.includes('grant select on table public.platform_capabilities to authenticated'))
check('founding tenant seeded with all four grants',
  /insert into public\.platform_capabilities[\s\S]*?true, true, true, true/.test(sql))
check('resolver joins customers to platform_capabilities on inbound_sms',
  sql.includes('create or replace function public.find_inbound_sms_customer')
  && /join public\.platform_capabilities pc\s*\n?\s*on pc\.user_id = cu\.user_id and pc\.inbound_sms/.test(sql))
check('resolver execute: revoked from public/anon/authenticated, granted to service_role only',
  sql.includes('revoke execute on function public.find_inbound_sms_customer(text) from public, anon, authenticated')
  && sql.includes('grant execute on function public.find_inbound_sms_customer(text) to service_role'))

// ═══════════════════════════════════════════════════════════════════════════
H('2. INBOUND SMS — the webhook resolves through the capability-scoped resolver')

const inbound = read('src/app/api/sms/inbound/route.ts')
check('webhook calls find_inbound_sms_customer',
  inbound.includes("rpc('find_inbound_sms_customer'"))
check('webhook no longer CALLS the global find_customer_by_phone (comments may name it)',
  !inbound.includes("rpc('find_customer_by_phone'"),
  'the global resolver files replies into whichever tenant added the phone most recently — release-gate C4')
check('no OTHER src file calls either phone resolver', (() => {
  const offenders: string[] = []
  walk(join(ROOT, 'src'), f => {
    if (!/\.(ts|tsx)$/.test(f)) return
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    if (rel === 'src/app/api/sms/inbound/route.ts') return
    const t = readFileSync(f, 'utf8')
    if (t.includes("rpc('find_customer_by_phone'") || t.includes("rpc('find_inbound_sms_customer'")) offenders.push(rel)
  })
  if (offenders.length) console.log(`     offenders: ${offenders.join(', ')}`)
  return offenders.length === 0
})())

// ═══════════════════════════════════════════════════════════════════════════
H('3. PAYMENT DOORS — every door to the shared Stripe account checks the grant')

// Every route that can mint a checkout/setup session, initiate a charge, or
// read the shared account — each must consult tenantCapabilities and branch on
// onlinePayments. remove-card routes are deliberately absent: removing a stored
// card is de-escalation and must always work.
const PAYMENT_DOORS = [
  'src/app/api/payments/checkout/route.ts',
  'src/app/api/payments/setup-card/route.ts',
  'src/app/api/payments/autopay/route.ts',
  'src/app/api/payments/reconcile/route.ts',
  'src/app/api/portal/pay/route.ts',
  'src/app/api/portal/quote-deposit/route.ts',
  'src/app/api/portal/setup-card/route.ts',
  'src/app/api/portal/autopay/route.ts',
  'src/lib/payments/autopay.ts',
]
for (const p of PAYMENT_DOORS) {
  const t = read(p)
  check(`${p} gates on the online_payments grant`,
    t.includes('tenantCapabilities') && t.includes('.onlinePayments'))
}
check('the AutoPay ENGINE refuses before any invoice read (covers the cron sweep)',
  (() => {
    const t = read('src/lib/payments/autopay.ts')
    const gate = t.indexOf('payments-not-enabled')
    const invoiceRead = t.indexOf(".from('invoices')")
    return gate > -1 && invoiceRead > -1 && gate < invoiceRead
  })(),
  'the sweep walks EVERY tenant\'s invoices; the refusal must come before the charge path starts')
check('/api/payments/status resolves the tenant (portal token or session), never just the env',
  (() => {
    const t = read('src/app/api/payments/status/route.ts')
    return t.includes('tenantCapabilities') && t.includes("searchParams.get('portal')") && t.includes("'not-enabled'")
  })())
check('PortalClient asks payments-status about ITS tenant (passes the portal token)',
  read('src/app/portal/[token]/PortalClient.tsx').includes('/api/payments/status?portal='))

// ═══════════════════════════════════════════════════════════════════════════
H('4. OUTBOUND — the shared senders are only reachable through audited call-sites')

// Files allowed to import the raw send functions. Everything customer-facing is
// capability-gated; the "to the business itself" trio is the platform mailing
// its own user (no borrowed identity, and a beta tenant still hears about its
// bookings and leads). portal-access is the platform answering a customer's own
// "send me my links" request — its email may span tenants by design.
//
// THE TEST for adding a line here: on whose behalf does this message go out? If
// it is a tenant speaking to its customers, it belongs behind a grant, in
// dispatch. If it is the PLATFORM speaking as itself — about an account, an
// invite, a login — no tenant is on the hook for it and no grant can sensibly
// gate it. Every entry below is one or the other, never "it was easier here".
const SEND_ALLOWLIST: Record<string, string> = {
  'src/lib/comms/dispatch.ts': 'THE chokepoint — capability-gated inside, alongside consent and the governor',
  'src/app/api/comms/send/route.ts': 'manual send — gated in-route (mirrors dispatch)',
  'src/app/api/comms/test/route.ts': 'owner self-test — gated in-route',
  'src/app/api/public/portal-access/route.ts': 'platform-transactional: customer-requested portal links',
  // Beta signup verification is the platform speaking AS ITSELF to someone who
  // is not a tenant yet — there is no tenant to hold an outbound_email grant
  // until the very verification this email performs. Same class as
  // portal-access; both routes are invite/token-gated and row-throttled
  // (beta_invites.send_count / last_sent_at), pinned by verify:beta-signup.
  'src/app/api/beta/signup/route.ts': 'platform-transactional: signup email verification (recipient predates the tenant)',
  'src/app/api/beta/resend/route.ts': 'platform-transactional: signup verification resend (row-throttled on the invite)',
  // Password recovery is the same class again, and the clearest case of it: the
  // platform emailing an EdgeQuote ACCOUNT HOLDER about their EdgeQuote login.
  // There is no tenant on whose behalf it is sent — the route deliberately does
  // not know who the address belongs to (finding out is the enumeration oracle
  // it exists to avoid), and the recipient may hold no tenant at all. Gating it
  // on a tenant grant would be incoherent: it would make "can this business text
  // its customers" decide whether its owner can get back into their own account.
  // Throttled per-address AND globally in password_reset_requests, pinned by
  // verify:account-recovery.
  'src/app/api/public/password-reset/route.ts': 'platform-transactional: owner password recovery (no tenant is on the hook for it)',
  // A crew invitation is the platform telling somebody that their EdgeHQ LOGIN
  // exists. Same class as the two above: it is about an account, not a message
  // the business is sending its customer, so no tenant is on the hook for it.
  // Gating it on outbound_email would make "can this business email its
  // customers" decide whether its own crew can be given a login — the same
  // incoherence spelled out for password recovery. The route is
  // owner-authenticated and proves ownership through RLS before it ever
  // constructs the admin client; the address is the one the owner typed for
  // their own employee. Pinned by verify:crew-auth.
  'src/app/api/crew/invite/route.ts': 'platform-transactional: worker login invitation (about an EdgeHQ account, not tenant→customer)',
  'src/app/api/booking/notify/route.ts': 'owner alert TO the business itself (customer half goes through dispatch)',
  'src/lib/intake.ts': 'lead alert TO the business itself',
  'src/app/api/cron/reports/route.ts': 'scheduled report TO the business itself',
}
const senders: string[] = []
walk(join(ROOT, 'src'), f => {
  if (!/\.(ts|tsx)$/.test(f)) return
  const t = readFileSync(f, 'utf8')
  // The import line is the door: match sendSms/sendEmail imported from the send
  // layer, not mere mentions (comments reference them freely).
  if (/import\s*\{[^}]*\bsend(Sms|Email)\b[^}]*\}\s*from\s*'(@\/lib\/comms\/send|\.\/send)'/.test(t)) {
    senders.push(relative(ROOT, f).replace(/\\/g, '/'))
  }
})
check('every sendSms/sendEmail importer is on the audited allowlist', (() => {
  const strays = senders.filter(s => !(s in SEND_ALLOWLIST))
  if (strays.length) console.log(`     unaudited sender(s): ${strays.join(', ')} — gate it or justify it here`)
  return strays.length === 0
})())
check('the allowlist has not silently emptied (chokepoint + manual route still import send)',
  senders.includes('src/lib/comms/dispatch.ts') && senders.includes('src/app/api/comms/send/route.ts'))
check('dispatch blocks per-channel on the tenant grants before the governor',
  (() => {
    // The per-channel rule now lives in lib/comms/reach as capabilityBlocks, so
    // the pure predicate (audience preview, follow-up queue) and the send path
    // share ONE definition instead of two that can drift. Dispatch still reads
    // the grants and still applies them ahead of the governor — which is what
    // this check is about — so it follows the seam across both files rather
    // than the old inline expression. Pinning the moved text here would have
    // reported RED for a refactor that strengthened the very thing it guards.
    const t = read('src/lib/comms/dispatch.ts')
    const cap = t.indexOf('capabilityBlocks(')
    const gov = t.indexOf('governCheck(')
    if (cap < 0 || gov < cap) return false
    if (!t.includes('tenantCapabilities(') || !t.includes('SKIP_REASON.NOT_ENABLED')) return false
    // Isolate the rule's own body before asserting it reads BOTH grants: run
    // over the whole file and a mention in a neighbouring comment or interface
    // satisfies the check without any code doing the work.
    const body = /export function capabilityBlocks[\s\S]*?\n}/.exec(read('src/lib/comms/reach.ts'))
    return !!body && body[0].includes('outboundSms') && body[0].includes('outboundEmail')
  })())
check('manual send route mirrors the same per-channel capability block',
  (() => {
    const t = read('src/app/api/comms/send/route.ts')
    return t.includes('outboundSms') && t.includes('outboundEmail') && t.includes("'not-enabled'")
  })())
check('the outcome summariser names the restriction (not the setup-gap copy)',
  read('src/lib/comms/sendOutcome.ts').includes("'not-enabled'"))

// ═══════════════════════════════════════════════════════════════════════════
H('5. THE APP ONLY READS GRANTS — no write path exists in src/')

check('no src file inserts/updates/upserts/deletes platform_capabilities', (() => {
  const offenders: string[] = []
  walk(join(ROOT, 'src'), f => {
    if (!/\.(ts|tsx)$/.test(f)) return
    const t = readFileSync(f, 'utf8')
    if (!t.includes('platform_capabilities')) return
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    // The one legal shape is the SELECT in lib/capabilities.
    if (/platform_capabilities'\)\s*[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/.test(t)) offenders.push(rel)
  })
  if (offenders.length) console.log(`     writer(s): ${offenders.join(', ')}`)
  return offenders.length === 0
})())
check('lib/capabilities fails CLOSED (error or missing row → NO_CAPABILITIES)',
  (() => {
    const t = read('src/lib/capabilities.ts')
    return t.includes('if (error || !data) return NO_CAPABILITIES') && t.includes('if (!userId) return NO_CAPABILITIES')
  })())

// ═══════════════════════════════════════════════════════════════════════════
// (the header is printed inside interlock() so it precedes its own results —
//  both sections below are async, so a module-scope H() would print both
//  headers before either produced a line)
//
// ⭐⭐ WHY THIS IS BEHAVIOURAL AND NOT A GREP. "This guard calls
// openFixtureTenant" is a source fact; "a false identity answer stops it before
// a single mutation" is a claim about ORDER, and order is exactly what was wrong
// before. So the harness is driven here against a recording fake and the
// assertion is that the fake recorded NO mutation — not that the code looks
// right.
//
// ⛔ Entirely offline. `@supabase/supabase-js` is replaced in require.cache
// before the harness is loaded, the four env names it reads are set to synthetic
// values FIRST (loadEnvLocal only fills variables that are undefined, so it
// cannot override them), and no client, socket or credential is real.

interface Recorder { mutations: string[]; rpcs: string[]; built: number; signedOut: boolean }

function fakeSupabase(rec: Recorder, answer: 'false' | 'missing' | 'error') {
  // ⭐ Every verb returns the SAME chain object, so any builder shape the harness
  // uses (`.delete().eq().lt()`, `.select().eq().maybeSingle()`) resolves rather
  // than throwing. A fake that dies on an unknown method turns a real finding
  // into a stack trace — and the stale-run sweep at verify-fixture.ts:147 is
  // exactly such a chain, immediately after the interlock.
  const table = (name: string) => {
    const chain: Record<string, unknown> = {}
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      chain[verb] = () => { rec.mutations.push(`${verb} ${name}`); return chain }
    }
    for (const p of ['select', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'is', 'like', 'match', 'limit', 'order', 'range']) {
      chain[p] = () => chain
    }
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.single = async () => ({ data: null, error: null })
    chain.then = (r: (v: unknown) => unknown) => r({ data: [], error: null })
    return chain
  }
  return {
    __zzFake: 'capabilities-interlock-probe',
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: 'zz-fixture-uid' } }, error: null }),
      signOut: async () => { rec.signedOut = true; return { error: null } },
    },
    rpc: async (name: string) => {
      rec.rpcs.push(name)
      if (name !== 'is_verify_fixture_tenant') return { data: null, error: null }
      if (answer === 'error') return { data: null, error: { message: 'zz-synthetic rpc failure' } }
      return { data: answer === 'missing' ? null : false, error: null }
    },
    from: table,
  }
}

async function probeInterlock(answer: 'false' | 'missing' | 'error'): Promise<Recorder & { exited: number | null; message: string; handedOut: boolean }> {
  const rec: Recorder = { mutations: [], rpcs: [], built: 0, signedOut: false }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const supaId = require.resolve('@supabase/supabase-js')
  const libId = require.resolve('./lib/verify-fixture')
  const savedSupa = require.cache[supaId], savedLib = require.cache[libId]
  // ⭐ The harness destructures `createClient` at ITS import time, so the fake
  // must be in place BEFORE the harness module is (re)loaded — replacing the
  // cache entry afterwards would leave the real binding captured.
  require.cache[supaId] = { id: supaId, filename: supaId, loaded: true,
    exports: { createClient: () => { rec.built++; return fakeSupabase(rec, answer) } } } as unknown as NodeModule
  delete require.cache[libId]

  const saved = { ...process.env }
  const savedExit = process.exit
  const savedErr = console.error
  let exited: number | null = null
  let handedOut = false
  let message = ''
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://zz-interlock-probe.invalid'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'zz-synthetic-anon'
    process.env.VERIFY_FIXTURE_EMAIL = 'zz-probe@edgequote.invalid'
    process.env.VERIFY_FIXTURE_PASSWORD = 'zz-synthetic-password'
    console.error = (...a: unknown[]) => { message += a.map(String).join(' ') }
    process.exit = ((code?: number) => { exited = code ?? 0; throw new Error('__zz_exit__') }) as typeof process.exit
    const lib = require(libId) as { openFixtureTenant: (l: string) => Promise<unknown> }
    const got = await lib.openFixtureTenant('interlock-probe') as { db?: unknown; skipped?: string }
    // ⭐⭐ THE LOAD-BEARING OBSERVATION. openFixtureTenant writes nothing itself
    // (fixtureCustomer/fixtureTemplate are lazy), so "no mutation happened while
    // it decided" is true even with the interlock removed — that assertion alone
    // would be vacuous. What actually matters is whether a WRITABLE SESSION was
    // handed back: with a false identity the caller must never receive a `db` it
    // could write through. That is the property a regression breaks.
    handedOut = got != null && got.db !== undefined
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__zz_exit__') throw e
  } finally {
    process.exit = savedExit
    console.error = savedErr
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    require.cache[supaId] = savedSupa; require.cache[libId] = savedLib
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { ...rec, exited, message, handedOut }
}

async function interlock() {
  H('6. THE INTERLOCK — refusal happens BEFORE any write, proven offline')
  for (const answer of ['false', 'missing', 'error'] as const) {
    const label = answer === 'false' ? 'says FALSE' : answer === 'missing' ? 'returns NULL (function missing / no answer)' : 'ERRORS'
    const r = await probeInterlock(answer)
    check(`the fake is installed, so this probe tests something (${answer})`, r.built > 0, `createClient built ${r.built} times`)
    check(`identity ${label} → the interlock was asked`, r.rpcs.includes('is_verify_fixture_tenant'), JSON.stringify(r.rpcs))
    check(`identity ${label} → the run ENDS (exit 1), it does not quietly skip`, r.exited === 1, `process.exit(${String(r.exited)})`)
    check(`identity ${label} → ⛔ NO writable session is handed back`, r.handedOut === false,
      'a caller that receives a db here can write to a real tenant — this is the check a removed interlock breaks')
    check(`identity ${label} → and no mutation was attempted while deciding`, r.mutations.length === 0, JSON.stringify(r.mutations))
    check(`identity ${label} → it says why, naming the refusal`, /REFUSING TO WRITE/.test(r.message), r.message.slice(0, 120))
  }
  // [negative control] the probe can SEE a mutation, so "zero mutations" is a
  // measurement rather than a fake that records nothing.
  const rec: Recorder = { mutations: [], rpcs: [], built: 0, signedOut: false }
  const c = fakeSupabase(rec, 'false') as unknown as { from: (t: string) => { insert: (v: unknown) => unknown } }
  c.from('platform_capabilities').insert({})
  check('[negative control] the recorder does register a write when one happens',
    rec.mutations.length === 1 && rec.mutations[0] === 'insert platform_capabilities', JSON.stringify(rec.mutations))
}

// ═══════════════════════════════════════════════════════════════════════════
async function live() {
  H('7. LIVE POSTURE — what the database actually refuses (needs credentials)')
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  ⏭️  skipped — no live Supabase credentials (CI runs with placeholders)')
    return
  }
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })

  // anon: the grants table and BOTH phone resolvers must refuse.
  {
    const { data, error } = await anon.from('platform_capabilities').select('user_id').limit(1)
    check('anon cannot read platform_capabilities', !!error || !(data && data.length),
      error ? undefined : 'anon read returned rows')
  }
  for (const fn of ['find_inbound_sms_customer', 'find_customer_by_phone']) {
    const { data, error } = await anon.rpc(fn, { p_phone: '+15005550006' })
    check(`anon cannot execute ${fn}`, !!error && !data, error ? undefined : `rpc returned ${JSON.stringify(data)}`)
  }

  // Signed-in business: may READ its own (absent) grant row, may not WRITE one.
  //
  // ⛔⛔ THE IDENTITY COMES FROM THE DATABASE, NOT FROM THE ENV VAR NAMES. This
  // half used to sign in with VERIFY_FIXTURE_EMAIL / _PASSWORD directly and write
  // immediately. That made the gate "these two variables are set" rather than
  // "the database agrees this is a fixture tenant" — so whoever pointed those
  // names at a real login got real INSERT/UPDATE attempts on that tenant's
  // platform_capabilities. The checks below are negative (they assert the writes
  // are REFUSED), but a refusal that has to be attempted against a real business
  // to be observed is the wrong shape, and if the policy ever regressed the row
  // would land before the assertion could report it.
  //
  // openFixtureTenant asks the database — rpc('is_verify_fixture_tenant') — and
  // ends the process before the first write if the answer is anything but true.
  // Same guarantee verify-quote-options and verify-service-bundles already have.
  const fixture = await openFixtureTenant('verify-capabilities')
  if (isSkipped(fixture)) {
    console.log(`  ⏭️  fixture-tenant half skipped — ${fixture.skipped}`)
    return
  }
  const { db, uid } = fixture
  try {
    {
      const { data, error } = await db.from('platform_capabilities').select('*').eq('user_id', uid)
      check('fixture tenant can ASK about its grants (SELECT-own policy works)', !error)
      check('fixture tenant holds NO grants (beta default is restriction)', !error && (data ?? []).length === 0,
        (data ?? []).length ? 'a grants row exists for the fixture tenant — remove it; an ungranted tenant is the posture every beta tenant starts from' : undefined)
    }
    {
      // The whole point: a business cannot grant itself a capability.
      const { error } = await db.from('platform_capabilities')
        .insert({ user_id: uid, online_payments: true, inbound_sms: true, outbound_sms: true, outbound_email: true })
      check('fixture tenant CANNOT grant itself capabilities (insert refused)', !!error)
    }
    {
      const { data, error } = await db.from('platform_capabilities')
        .update({ online_payments: true }).eq('user_id', uid).select()
      check('fixture tenant CANNOT update grants (no row reachable, no policy)', !!error || (data ?? []).length === 0)
    }
    {
      // And the row it failed to create really does not exist afterwards.
      const { data } = await db.from('platform_capabilities').select('user_id').eq('user_id', uid)
      check('no grants row appeared as a side effect', (data ?? []).length === 0)
    }
  } finally {
    // close() deletes anything this run made and signs out with scope:'local'
    // (never global — see auth-session-persistence). This guard creates no rows
    // by design, so close() is a sign-out plus a no-op sweep; it is called
    // anyway so the cleanup contract is the harness's, not re-implemented here.
    await fixture.close()
  }

  // Resolver behaviour (capable vs not) needs the service role to call it and to
  // stage a grant row; .env.local deliberately holds no service key. Proven at
  // apply time via direct SQL (see session log); structurally pinned above.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  ⏭️  resolver capable/incapable behaviour needs SUPABASE_SERVICE_ROLE_KEY — structural pins + apply-time proof cover it')
  }
}

function walk(dir: string, visit: (f: string) => void) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, visit)
    else visit(p)
  }
}

interlock().then(live).then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} verify-capabilities: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}).catch(e => {
  console.error('verify-capabilities crashed:', e)
  process.exit(1)
})
