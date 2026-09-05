// ── Read-only: did converging the two classifiers change any real row? ───────
//
//   node scripts/fixture-divergence-report.mjs
//
// ⛔⛔ READ-ONLY BY CONSTRUCTION. There is no insert, update, upsert, delete or
//     rpc call in this file, and there must never be one. It answers exactly one
//     question about the owner's live book:
//
//       for every name the classifiers actually see, does OLD (Growth's
//       FIXTURE_MARKERS) disagree with NEW (lib/fixtureData)?
//
// ⭐ Both rules are evaluated HERE, side by side, over the same rows. The OLD one
// is reproduced verbatim from the pre-convergence source rather than imported,
// because the whole point of the change is that it no longer exists — a report
// that imported it would be measuring the new rule against itself.
//
// ⚠️ A disagreement is not automatically a defect. Two are EXPECTED and named
// below; anything else is a finding and this exits non-zero.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = process.env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = process.env.PORTAL_RPC_OWNER_PASSWORD
if (!URL || !ANON || !EMAIL || !PASSWORD) {
  console.error('\n⛔ needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY + PORTAL_RPC_OWNER_EMAIL/PASSWORD in .env.local\n')
  process.exit(2)
}

// ⭐ Signs in as the OWNER and reads through RLS — the least-privilege path, and
// the same one the app uses. No service-role key is needed to answer this, so
// none is requested.
const sb = createClient(URL, ANON, { auth: { persistSession: false } })
const auth = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('sign-in failed: ' + auth.error.message); process.exit(2) }

// ── OLD: Growth's FIXTURE_MARKERS, verbatim from main@a44195be ───────────────
const OLD_MARKERS = [
  /\bfixture\b/i,
  /\bdelete\s*me\b/i,
  /\bdo\s*not\s*use\b/i,
  /\b(test|demo|sample|dummy)\s*(data|record|customer|account|job|service)\b/i,
  /^(zz|xx|qa|tmp|temp)[\s\-_]/i,
  /^s\d{2,3}\s/i,
  /\btest@|@example\.(com|org)\b/i,
]
const oldLooksLikeFixture = (...texts) => {
  for (const t of texts) {
    const s = String(t ?? '').trim()
    if (!s) continue
    if (OLD_MARKERS.some(rx => rx.test(s))) return true
  }
  return false
}

// ── NEW: the canonical rule ──────────────────────────────────────────────────
const { isAnyFixtureName } = await import('../src/lib/fixtureData.ts')

const page = async (table, cols) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

console.log('\n══ Fixture classifier convergence — production divergence (READ-ONLY) ══\n')

// The fields the classifiers are actually shown. Growth passes customer name and
// service type; the canonical callers pass display names and document numbers.
const sources = [
  { label: 'customers',         rows: await page('customers', 'id, name'),                       names: r => [r.name] },
  { label: 'technicians',       rows: await page('technicians', 'id, name'),                     names: r => [r.name] },
  { label: 'crews',             rows: await page('crews', 'id, name'),                           names: r => [r.name] },
  { label: 'service_templates', rows: await page('service_templates', 'id, name'),               names: r => [r.name] },
  { label: 'jobs',              rows: await page('jobs', 'id, title, service_type'),             names: r => [r.title, r.service_type] },
  { label: 'quotes',            rows: await page('quotes', 'id, quote_number, customer_name'),   names: r => [r.quote_number, r.customer_name] },
  { label: 'invoices',          rows: await page('invoices', 'id, invoice_number, customer_name'), names: r => [r.invoice_number, r.customer_name] },
]

// ⭐ EXPECTED disagreements — the whole reason for the change. Any row matching
// one of these is reported but does not fail the run; anything else does.
const EXPECTED = [
  {
    why: 'OLD hid a legitimate name (over-broad single-word rule) — the defect being fixed',
    test: (names) => oldLooksLikeFixture(...names) && !isAnyFixtureName(...names),
  },
  {
    why: 'NEW catches a machine fixture OLD missed (no VERIFY-/harness-shape rule)',
    test: (names) => !oldLooksLikeFixture(...names) && isAnyFixtureName(...names),
  },
]

let scanned = 0, diverged = 0
const findings = []

for (const s of sources) {
  let oldN = 0, newN = 0, diffN = 0
  for (const r of s.rows) {
    const names = s.names(r).filter(Boolean)
    if (!names.length) continue
    scanned++
    const o = oldLooksLikeFixture(...names)
    const n = isAnyFixtureName(...names)
    if (o) oldN++
    if (n) newN++
    if (o !== n) {
      diffN++; diverged++
      const why = EXPECTED.find(e => e.test(names))?.why ?? '⛔ UNEXPECTED'
      findings.push({ table: s.label, names: names.join(' · '), old: o, new: n, why })
    }
  }
  console.log(`  ${s.label.padEnd(18)} rows ${String(s.rows.length).padStart(5)}   OLD flagged ${String(oldN).padStart(4)}   NEW flagged ${String(newN).padStart(4)}   differ ${String(diffN).padStart(4)}`)
}

console.log(`\n  scanned ${scanned} named values · ${diverged} divergence(s)\n`)

if (findings.length) {
  for (const f of findings) {
    console.log(`  ${f.why}`)
    console.log(`    ${f.table}: “${f.names}”   OLD=${f.old ? 'fixture' : 'real'}  NEW=${f.new ? 'fixture' : 'real'}`)
  }
  console.log('')
}

const unexpected = findings.filter(f => f.why.startsWith('⛔'))
console.log(unexpected.length === 0
  ? `✅ zero UNEXPECTED divergence — the convergence changes no row the rules did not intend\n`
  : `❌ ${unexpected.length} UNEXPECTED divergence(s) — investigate before landing\n`)
console.log('⛔ Nothing was written. This report reads and classifies; it never mutates.\n')
process.exit(unexpected.length === 0 ? 0 : 1)
