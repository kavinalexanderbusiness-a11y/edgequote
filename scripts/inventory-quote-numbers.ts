// ── Production quote-number inventory (READ ONLY) ────────────────────────────
//
// ⛔⛔ THIS SCRIPT WRITES NOTHING. It signs in as the owner and issues SELECTs
// only — no insert, no update, no delete, no RPC that mutates. It exists to
// answer one question before any uniqueness constraint is designed: does
// production already contain duplicate quote numbers, and if so, which rows?
//
// A UNIQUE index cannot be created over data that already violates it, so this
// inventory is a hard precondition for the migration, not background colour.
//
//   npx tsx scripts/inventory-quote-numbers.ts
//
// ⛔ Prints no secrets. The tenant id is shown truncated.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const email = process.env.PORTAL_RPC_OWNER_EMAIL
const password = process.env.PORTAL_RPC_OWNER_PASSWORD

async function main() {
  if (!url || !anon || !email || !password) {
    console.log('\n⏭  PRODUCTION ACCESS UNAVAILABLE — no owner credentials in .env.local.')
    console.log('   The local concurrency proof still stands on its own.\n')
    process.exit(0)
  }

  const sb = createClient(url, anon, { auth: { persistSession: false } })
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password })
  if (authErr || !auth.user) {
    console.log(`\n⏭  PRODUCTION ACCESS UNAVAILABLE — sign-in refused (${authErr?.message ?? 'no user'}).\n`)
    process.exit(0)
  }
  const uid = auth.user.id
  console.log(`\n  Signed in as owner ${uid.slice(0, 8)}…  (RLS scopes every read below to this tenant)\n`)

  // ⭐ READ ONLY. Every statement from here is a SELECT.
  const { data, error } = await sb
    .from('quotes')
    .select('id, user_id, quote_number, created_at, status')
    .order('created_at', { ascending: true })
  if (error) { console.error(`  ✗ could not read quotes: ${error.message}`); process.exit(1) }

  const rows = (data ?? []) as { id: string; user_id: string; quote_number: string | null; created_at: string; status: string }[]
  console.log(`  TOTAL QUOTES VISIBLE: ${rows.length}`)

  const tenants = new Set(rows.map(r => r.user_id))
  console.log(`  TENANTS VISIBLE: ${tenants.size} (RLS: the owner's own tenant only)\n`)

  // ── Duplicates, per tenant ────────────────────────────────────────────────
  const byKey = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.user_id}::${r.quote_number ?? '<null>'}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(r)
  }
  const dupes = [...byKey.entries()].filter(([, g]) => g.length > 1)

  console.log(`  ── DUPLICATE QUOTE NUMBERS (per tenant) ─────────────────────`)
  if (!dupes.length) {
    console.log('  none\n')
  } else {
    console.log(`  ${dupes.length} duplicated number(s):\n`)
    for (const [key, group] of dupes) {
      const num = key.split('::')[1]
      console.log(`   ${num}  ×${group.length}`)
      for (const r of group) {
        console.log(`     - ${r.id}  created ${r.created_at}  status=${r.status}`)
      }
    }
    console.log('')
  }

  // ── The two numbers the brief names explicitly ────────────────────────────
  for (const target of ['EPS-2026-0008', 'EPS-2026-0009']) {
    const g = rows.filter(r => r.quote_number === target)
    console.log(`  ${target}: ${g.length === 0 ? 'not present' : g.length === 1 ? 'present, unique' : `DUPLICATED ×${g.length}`}`)
    if (g.length > 1) for (const r of g) console.log(`     - ${r.id}  created ${r.created_at}`)
  }
  console.log('')

  // ── Malformed / year disagreement / gaps ──────────────────────────────────
  const SHAPE = /^([A-Za-z][A-Za-z0-9]*)-(\d{4})-(\d{4})$/
  const malformed = rows.filter(r => !r.quote_number || !SHAPE.test(r.quote_number))
  console.log(`  ── MALFORMED (not PREFIX-YYYY-NNNN) ─────────────────────────`)
  console.log(malformed.length ? malformed.map(r => `   ${r.quote_number ?? '<null>'}  ${r.id}`).join('\n') : '  none')
  console.log('')

  const yearMismatch = rows.filter(r => {
    const m = r.quote_number && SHAPE.exec(r.quote_number)
    if (!m) return false
    return m[2] !== String(new Date(r.created_at).getUTCFullYear())
  })
  console.log(`  ── NUMBER YEAR vs created_at YEAR ───────────────────────────`)
  console.log(yearMismatch.length
    ? yearMismatch.map(r => `   ${r.quote_number}  created ${r.created_at.slice(0, 10)}`).join('\n')
    : '  every number agrees with its created_at year')
  console.log('')

  // Gaps, per (tenant, prefix, year) — the scope the DB allocator already uses.
  const series = new Map<string, number[]>()
  for (const r of rows) {
    const m = r.quote_number && SHAPE.exec(r.quote_number)
    if (!m) continue
    const key = `${r.user_id}::${m[1]}::${m[2]}`
    if (!series.has(key)) series.set(key, [])
    series.get(key)!.push(Number(m[3]))
  }
  console.log(`  ── SERIES (tenant · prefix · year) ──────────────────────────`)
  for (const [key, nums] of series) {
    const sorted = [...nums].sort((a, b) => a - b)
    const lo = sorted[0], hi = sorted[sorted.length - 1]
    const present = new Set(sorted)
    const gaps: number[] = []
    for (let i = lo; i <= hi; i++) if (!present.has(i)) gaps.push(i)
    const [t, prefix, year] = key.split('::')
    console.log(`   ${prefix}-${year} (tenant ${t.slice(0, 8)}…): ${sorted.length} quotes, range ${lo}–${hi}`)
    console.log(`     distinct numbers: ${present.size}${present.size !== sorted.length ? `  ⚠️ ${sorted.length - present.size} DUPLICATE allocation(s)` : ''}`)
    console.log(`     gaps: ${gaps.length ? gaps.join(', ') : 'none'}`)
  }
  console.log('')

  // ⭐ THE VERDICT THE MIGRATION NEEDS.
  console.log('  ── VERDICT ──────────────────────────────────────────────────')
  console.log(dupes.length
    ? `  ⛔ A UNIQUE (user_id, quote_number) index CANNOT be created as-is —\n     ${dupes.length} duplicate group(s) must be resolved by the owner first.`
    : '  ✅ No duplicates in the visible tenant — UNIQUE (user_id, quote_number)\n     would be creatable for this tenant. Other tenants are not visible under RLS.')
  console.log('')

  // Explicit scope: a bare signOut() defaults to GLOBAL and would end the
  // owner's sessions everywhere, from a read-only inventory script.
  await sb.auth.signOut({ scope: 'local' })
}

main().catch(e => { console.error(e); process.exit(1) })
