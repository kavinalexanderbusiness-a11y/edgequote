// ── Verify: a guard cannot write into the real book ──────────────────────────
//   npm run verify:fixture-isolation
//
// THE INCIDENT. On 2026-08-11 the owner's notification bell filled with
// "Automated guard fixture — safe to delete accepted a quote" — forty-five of
// them in two hours, each linking to a quote that no longer existed.
//
// `verify:quote-options` was creating its fixture quote in the OWNER's tenant,
// attaching it to a REAL customer (whichever live portal token came back first),
// and accepting it through that customer's own portal door. `trg_notify_quote_
// accepted` fires on any quote reaching 'accepted' and notifies the quote's
// user_id, so every run rang the owner's bell. A real customer's portal, for as
// long as each run took, showed a $5,550 job at "1 Verification Way".
//
// WHAT THIS GUARD PINS. The trigger was never the bug and did not change; a
// suppression branch on a notification path is how real alerts go missing. The
// TENANT was the bug. So the invariant is about WHERE a guard writes:
//
//   ⭐ A verify script that writes to the database must go through
//      scripts/lib/verify-fixture, and must not hold owner credentials.
//
// That is a property of the source, checkable without a database — so it runs in
// CI, on every push, with no credentials at all. The live section below adds the
// behavioural half when credentials exist: it signs in as the OWNER, read-only,
// and asserts that no fixture artefact is present in the real book.
//
// ⚠️ THIS GUARD WRITES NOTHING, EVER — not even a fixture. It is the one place
// that must be trustworthy when everything else is suspect.

import { baselineFile } from './lib/schema-source'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadEnvLocal } from './lib/verify-fixture'

loadEnvLocal()

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const SCRIPTS = join(process.cwd(), 'scripts')
const files = readdirSync(SCRIPTS)
  .filter(f => f.startsWith('verify-') && f.endsWith('.ts'))
  .map(f => ({ name: f, text: readFileSync(join(SCRIPTS, f), 'utf8') }))

// A supabase table write, in the chain form every guard uses: a receiver, then
// `from` naming a quoted table, then insert / upsert / update / delete.
//
// ⚠️ Written so this file does not match its OWN description. Spelling the chain
// out literally here made this guard detect ITSELF as a writer — the same
// grep-your-own-subject trap that once made a hardening guard report the cure as
// the disease. Section 1b asserts the read-only contract instead of exempting
// this file by name, so the coverage is tightened rather than waived.
//
// Scoped to a .from('<table>') chain on purpose — a bare /\.delete\(/ also matches
// `someSet.delete(key)`, which verify-undo-contract does on a plain JS Set.
//
// ⚠️ AND ANCHORED TO A REAL RECEIVER. Several guards are pure static analysers
// that SEARCH APPLICATION SOURCE for these very chains: verify-data-honesty holds
// the literal ".from('invoices').insert(" to find where the app mints an invoice
// number. Without the identifier prefix this guard read that string as a write and
// accused a guard that never opens a connection — reporting the cure as the
// disease, which this repo has done before. `owner.from(` matches; `".from(` and
// `supabase\.from\(` inside a regex literal do not.
const TABLE_WRITE = /(?<![\w$])[A-Za-z_$][\w$]*\.from\((['"`])[a-z_]+\1\)\s*(?:\r?\n\s*)?\.(insert|upsert|update|delete)\(/
// The env names that address a REAL business. A script that writes must not name
// one; a read-only guard still may (verify:portal-rpc reads the owner's book to
// learn what SHOULD be visible, and writes nothing).
const OWNER_CREDENTIALS = /PORTAL_RPC_OWNER_(EMAIL|PASSWORD)|BACKFILL_OWNER_(EMAIL|PASSWORD)/
const HARNESS = /from '\.\/lib\/verify-fixture'/

console.log('\n═══ 1. Every writing guard writes through the fixture harness ═══')

const writers = files.filter(f => TABLE_WRITE.test(f.text))
// ANTI-VACUITY, and it must be by NAME. "at least one writer" would still pass if
// the pattern silently stopped matching the two guards this whole boundary exists
// for — every per-writer assertion below would then vacuously hold over an empty
// set, and the suite would go green on no coverage at all. These two are known to
// write; if either stops being detected, the detector is broken, not the guard.
for (const known of ['verify-quote-options.ts', 'verify-service-bundles.ts']) {
  check(`${known} is still detected as a writing guard`,
    writers.some(w => w.name === known),
    'it writes fixtures to a live database; if TABLE_WRITE no longer sees that, every '
    + 'check below is asserting over an empty set and this suite proves nothing')
}
console.log(`  (${writers.length} writing guard(s) of ${files.length}: ${writers.map(w => w.name).join(', ')})`)

for (const w of writers) {
  check(`${w.name} writes through the fixture harness`,
    HARNESS.test(w.text),
    'it writes rows but does not import scripts/lib/verify-fixture, so nothing checks '
    + 'which tenant those rows land in')
  check(`${w.name} holds no owner credentials`,
    !OWNER_CREDENTIALS.test(w.text),
    'a guard that writes must not be able to sign in as a real business — this is the '
    + 'exact line that put 45 alerts in the owner\'s bell on 2026-08-11')
}

// ── 1b. This guard's own contract ────────────────────────────────────────────
// It holds owner credentials, so it is the one file in scripts/ where a stray
// write would land straight in the real book. Asserted, not assumed — and
// asserted here rather than by adding this filename to an exemption list, because
// an exemption would still be sitting there the day someone adds a write.
const SELF = files.find(f => f.name === 'verify-fixture-isolation.ts')!
check('this guard performs no table write of its own',
  !TABLE_WRITE.test(SELF.text),
  'verify-fixture-isolation reads the owner\'s book with the owner\'s credentials; it '
  + 'must never be the thing that writes to it')

console.log('\n═══ 2. The harness interlock is intact ═══')

const harness = readFileSync(join(SCRIPTS, 'lib', 'verify-fixture.ts'), 'utf8')
check('the harness asks the database whether the tenant is a fixture tenant',
  /rpc\(\s*'is_verify_fixture_tenant'\s*\)/.test(harness),
  'the marker is the only thing standing between a guard and a real book')
check('…and REFUSES on anything but a literal true',
  /marked !== true/.test(harness),
  'a null or undefined answer — the shape an RPC returns when it has been dropped or '
  + 'its grant revoked — must refuse, not fall through')
check('…by ending the process, not by returning a skip',
  /process\.exit\(1\)/.test(harness),
  'a skip here would quietly do less; the run must stop loudly')
check('the refusal happens before any write',
  harness.indexOf('is_verify_fixture_tenant') < harness.indexOf('.insert('),
  'the interlock must be upstream of the first insert in the file, or it guards nothing')
check('fixture names carry a per-run id',
  /const tag = \(base: string\) => `ZZ-\$\{base\}-\$\{runId\}`/.test(harness),
  'a shared constant name is what let two concurrent runs delete each other\'s fixtures')
check('abandoned runs are swept by AGE, never by name',
  /lt\('created_at', staleBefore\)/.test(harness),
  'a name-based sweep reaches a concurrent run\'s live rows; an age-based one cannot')
check('the fixture customer is undeliverable on both channels',
  /edgequote\.invalid/.test(harness) && /\+15550100/.test(harness),
  'RFC 2606 .invalid and the reserved +1 555 01xx range — if a send path were ever '
  + 'reached, there is nowhere for it to arrive')
check('the fixture customer is opted OUT of both channels',
  /sms_opt_in: false, email_opt_in: false/.test(harness),
  'consent is the gate every send path checks first')

console.log('\n═══ 3. The marker grants nothing to the application ═══')

// The whole safety argument depends on this: the marker gates SCRIPTS, never
// behaviour. The moment a trigger, policy, route or component consults it, a test
// flag has become a business rule — and then it is worth forging.
const appDirs = ['src', 'supabase']
const appHits: string[] = []
const walk = (dir: string) => {
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) { walk(rel); continue }
    if (!/\.(ts|tsx|sql)$/.test(e.name)) continue
    const text = readFileSync(join(process.cwd(), rel), 'utf8')
    // DEFINING the marker is legitimate; CONSULTING it is not. Three files define it:
    // the original migration, its archived copy, and the generated baseline (which is
    // the schema, so of course it declares the table and the function). Exempting them
    // does not soften the claim — the claim is re-made below, and made STRONGER, by
    // asserting that no policy or trigger in the baseline branches on the marker.
    if (rel.endsWith('RUN-2026-08-11-verify-fixture-tenant.sql')) continue
    if (rel.startsWith('supabase/archive/')) continue          // history, never applied
    if (/supabase\/migrations\/.*_baseline\.sql$/.test(rel)) continue
    if (/verify_fixture_tenants|is_verify_fixture_tenant/.test(text)) appHits.push(rel)
  }
}
for (const d of appDirs) walk(d)
check('no application code reads the fixture marker',
  appHits.length === 0,
  `${appHits.join(', ')} consults it — a marker that changes behaviour is a test bypass, `
  + 'and a test bypass is worth forging')

// The baseline IS the schema now, so "no policy or trigger consults the marker" has
// to be asserted against it directly rather than inferred from its absence. A RLS
// predicate that reads is_verify_fixture_tenant() would let anyone who can write the
// marker table read past a tenant boundary — which is exactly why it grants nothing.
{
  const baseline = baselineFile()
  const sql = baseline ? readFileSync(join(process.cwd(), baseline), 'utf8') : ''
  const behaviour = sql
    .split(';')
    .filter(s => /verify_fixture_tenants|is_verify_fixture_tenant/.test(s))
    .filter(s => /create\s+policy|create\s+(constraint\s+)?trigger/i.test(s))
  check('no policy or trigger in the baseline branches on the fixture marker',
    behaviour.length === 0,
    `${behaviour.length} statement(s) consult it — the marker would stop being inert`)
}

console.log('\n═══ 4. Live: the real book carries no fixture artefact ═══')

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anonKey || url.includes('placeholder') || !email || !password) {
    console.log('  … SKIPPED — needs live credentials; sections 1–3 above ran in full')
    return
  }
  // Read-only. This guard is the one that must never write.
  const owner = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: auth, error: authErr } = await owner.auth.signInWithPassword({ email, password })
  if (authErr || !auth?.user) { console.log(`  … SKIPPED — owner sign-in failed (${authErr?.message})`); return }
  const uid = auth.user.id

  const marked = await owner.rpc('is_verify_fixture_tenant')
  check('the OWNER is not marked as a fixture tenant',
    marked.data === false,
    `returned ${JSON.stringify(marked.data)} — if the owner were marked, the harness would `
    + 'happily write fixtures into the real book')

  const countLike = async (table: string, col: string) => {
    const { count } = await owner.from(table).select('id', { count: 'exact', head: true })
      .eq('user_id', uid).like(col, 'ZZ-%')
    return count ?? -1
  }
  const zzQuotes = await countLike('quotes', 'quote_number')
  const zzBundles = await countLike('service_bundles', 'name')
  const zzCustomers = await countLike('customers', 'name')
  const zzTemplates = await countLike('service_templates', 'name')
  check('no ZZ- fixture row remains anywhere in the owner\'s book',
    zzQuotes === 0 && zzBundles === 0 && zzCustomers === 0 && zzTemplates === 0,
    `quotes=${zzQuotes} bundles=${zzBundles} customers=${zzCustomers} templates=${zzTemplates}`)

  // THE symptom the owner actually saw. Notifications have no FK to the quote they
  // describe, so deleting a fixture quote never removed its alert — 45 of them
  // survived pointing at rows that no longer existed.
  const { count: fixtureNotifs } = await owner.from('notifications')
    .select('id', { count: 'exact', head: true }).eq('user_id', uid)
    .or('title.ilike.%guard fixture%,title.ilike.%ZZ-VERIFY%,body.ilike.%ZZ-VERIFY%,body.ilike.%Verification Way%')
  check('no fixture notification is in the owner\'s bell',
    (fixtureNotifs ?? -1) === 0,
    `${fixtureNotifs} remain — this is the exact symptom of 2026-08-11`)

  // Cheap, and it is the assertion that would have caught the original defect at
  // any point in the two hours it was running.
  const { data: liveCustomer } = await owner.from('customers')
    .select('id').eq('user_id', uid).like('name', 'ZZ-%').limit(1).maybeSingle()
  check('no real customer carries a fixture name',
    liveCustomer === null,
    'a fixture customer in the real book is a fake person in a real CRM')

  // ⚠️ scope:'local' is LOAD-BEARING. supabase-js defaults signOut() to
  // scope:'global', which revokes EVERY session this account holds ANYWHERE —
  // and this guard signs in as the REAL owner. A bare signOut() here signs the
  // owner out of their own phone and desktop mid-workday. Production logged 214
  // `/auth/v1/logout?scope=global` calls in 24 hours, every one from `node` on a
  // dev machine, and that was THE cause of the random sign-outs.
  await owner.auth.signOut({ scope: 'local' }).catch(() => {})
}

live()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    console.log(failures === 0
      ? '\n✅ verify:fixture-isolation — a guard writes only into a tenant nobody is watching\n'
      : `\n❌ verify:fixture-isolation — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
