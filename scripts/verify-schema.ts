// ── Live schema drift guard — `npm run verify:schema` ────────────────────────
//
// THE FAILURE THIS EXISTS TO STOP, stated plainly: on 2026-08-13 an audit found
// that 30 migrations had reached production leaving NO file in this repository.
// While that audit was still running, five more landed — three from a parallel
// session, and one fifteen seconds after another. Nobody was careless. There was
// simply no instrument that could tell you production and the repo disagreed.
//
// This is that instrument. It asks production for a hash of its own shape and
// compares it to supabase/contract/fingerprint.json — the snapshot the committed
// baseline was generated from. If they differ, something changed in the database
// that this repository does not know about, and a rebuild would not reproduce it.
//
// WHY IT NAMES A SECTION, NOT A DIFF: schema_fingerprint() deliberately returns
// only counts and md5s — no names, no data — so it is safe to grant to any signed-in
// caller. "policies drifted, 327 → 329" is enough to act on; the next step is
// `npm run schema:contract`, which fetches the detail as service_role.
//
// ── PAIRED WITH verify:rebuild ───────────────────────────────────────────────
//   verify:schema   production  vs  the contract snapshot   → the DB moved
//   verify:rebuild  the baseline vs the contract snapshot   → the repo moved
// Both green means the repo can rebuild what is actually running.
//
// Read-only. No writes, no DDL. Skips clean without credentials.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const CONTRACT = 'supabase/contract/fingerprint.json'
type Section = { n: number; md5: string }
type Fingerprint = {
  overall: string
  latest_migration?: string
  sections: Record<string, Section>
  captured_at?: string
  baseline?: string
}

async function main() {
  console.log('\n══ schema drift: production vs this repository ══════════════════════════\n')

  if (!existsSync(CONTRACT)) {
    console.error(`  ✗ ${CONTRACT} is missing — there is nothing to compare production against.`)
    console.error('    Capture it with: npm run schema:contract')
    process.exit(1)
  }
  const expected: Fingerprint = JSON.parse(readFileSync(CONTRACT, 'utf8'))
  console.log(`  contract captured: ${expected.captured_at ?? 'unknown'}`)
  console.log(`  baseline:          ${expected.baseline ?? 'unknown'}\n`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD

  if (!url || !anonKey || !email || !password) {
    console.log('  ⏭  SKIPPED — no credentials, so production was never contacted.')
    console.log('     This guard is the only thing that notices production changing underneath')
    console.log('     the repo. Run it with credentials before any release.\n')
    // Exit 2, not 0. Answering "success" because the check could not be attempted
    // is how this suite stayed green through two schema drifts: verify-all counts
    // a 0 as proof. 2 means "could not run", which is reported separately and
    // never as a pass.
    process.exit(2)
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError) {
    console.error(`  ✗ owner sign-in failed: ${signInError.message}`)
    process.exit(1)
  }

  const { data, error } = await supabase.rpc('schema_fingerprint')

  // signOut() defaults to GLOBAL scope and would revoke the owner's other sessions —
  // including the phone in their pocket. Local only. (auth-session-persistence, 2026-08-12)
  await supabase.auth.signOut({ scope: 'local' })

  // A missing function is itself the finding: the guard cannot see production, so
  // "no drift reported" would be a lie. Fail loudly rather than skip quietly.
  if (error) {
    console.error(`  ✗ schema_fingerprint() could not be called: ${error.message}`)
    if (/does not exist|schema cache/i.test(error.message)) {
      console.error('\n    The function is missing from production. It ships in the baseline')
      console.error('    (supabase/migrations/*_baseline.sql). Until it exists, drift is invisible.')
    }
    process.exit(1)
  }

  const live = data as Fingerprint

  console.log('── section by section ──')
  const sectionNames = [...new Set([...Object.keys(expected.sections), ...Object.keys(live.sections ?? {})])].sort()
  const drifted: string[] = []

  for (const name of sectionNames) {
    const e = expected.sections[name]
    const l = live.sections?.[name]
    if (!e) { check(name, false, `production has a section the contract does not: ${name}`); drifted.push(name); continue }
    if (!l) { check(name, false, `the contract expects a section production did not return: ${name}`); drifted.push(name); continue }
    if (e.md5 === l.md5) {
      check(`${name} (${l.n})`, true)
    } else {
      drifted.push(name)
      const delta = l.n === e.n ? `same count (${l.n}), different content` : `${e.n} → ${l.n}`
      check(name, false, `DRIFTED — ${delta}`)
    }
  }

  console.log('\n── overall ──')
  check('production matches the committed contract exactly', expected.overall === live.overall)

  if (expected.latest_migration && live.latest_migration && expected.latest_migration !== live.latest_migration) {
    console.log('\n  ℹ migrations applied since this contract was captured:')
    console.log(`      contract: ${expected.latest_migration}`)
    console.log(`      live:     ${live.latest_migration}`)
  }

  console.log(`\n${'─'.repeat(72)}`)
  if (fail === 0) {
    console.log(`NO DRIFT — ${pass} checks passed.`)
    console.log('Production is exactly the schema this repository can rebuild.\n')
  } else {
    console.error(`SCHEMA DRIFT — ${drifted.length} section(s) differ: ${drifted.join(', ')}`)
    console.error('\nProduction has changed and this repository does not know about it. A rebuild')
    console.error('from the current baseline would NOT reproduce what is running.')
    console.error('\nThis is not fixed by editing fingerprint.json. Resync, in this order:')
    console.error('  1. npm run schema:contract   # re-read production into supabase/contract/')
    console.error('  2. npm run schema:baseline   # regenerate the baseline from that capture')
    console.error('  3. npm run verify:rebuild    # prove the new baseline still builds from zero')
    console.error('  4. commit supabase/ — including the recovered migration under archive/ledger/')
    console.error('\nIf you did not expect a change, find out who applied it before resyncing:')
    console.error('  select version, name from supabase_migrations.schema_migrations order by version desc limit 5;\n')
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
