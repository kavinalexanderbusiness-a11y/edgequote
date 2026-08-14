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
import { loadEnvLocal } from './lib/verify-fixture'

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

const sql = read('supabase/RUN-2026-08-13-platform-capabilities.sql')
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
    const t = read('src/lib/comms/dispatch.ts')
    const cap = t.indexOf('outboundSms')
    const gov = t.indexOf('governCheck(')
    return cap > -1 && t.includes('outboundEmail') && t.includes('SKIP_REASON.NOT_ENABLED') && gov > cap
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
H('6. LIVE POSTURE — what the database actually refuses (needs credentials)')

async function live() {
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
  const email = process.env.VERIFY_FIXTURE_EMAIL, password = process.env.VERIFY_FIXTURE_PASSWORD
  if (!email || !password) {
    console.log('  ⏭️  fixture-tenant half skipped — set VERIFY_FIXTURE_EMAIL / VERIFY_FIXTURE_PASSWORD')
    return
  }
  const db = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: auth, error: authErr } = await db.auth.signInWithPassword({ email, password })
  if (authErr || !auth?.user) {
    console.log(`  ⏭️  fixture-tenant half skipped — sign-in failed (${authErr?.message ?? 'no user'})`)
    return
  }
  const uid = auth.user.id
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
    await db.auth.signOut({ scope: 'local' }) // never global — see auth-session-persistence
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

live().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} verify-capabilities: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}).catch(e => {
  console.error('verify-capabilities crashed:', e)
  process.exit(1)
})
