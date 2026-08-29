// ── Reconciliation report: what the existing $0 records actually mean ────────
//
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/unpriced-reconcile.mjs
//
// ⛔⛔ READ-ONLY, BY CONSTRUCTION. There is no insert, update, upsert, delete or
//     rpc call anywhere in this file, and there must never be one. Every $0 row
//     in production was created by a system that could not tell "free" from
//     "unpriced" — so the app CANNOT now decide which any given row meant. Only
//     a human who was there can. Rewriting them automatically would replace an
//     honest unknown with a confident guess, which is the failure this whole
//     lane exists to stop.
//
//     The output is three buckets and a question. It is not a migration, and it
//     must not become one.
//
// The classification RULES live in src/lib/pricingState (`classifyLegacyZero`)
// and are proven by verify:unpriced-work §8c without touching a database. This
// file is only the reader that feeds them.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'

// Minimal .env.local reader — the same shape scripts/lib/verify-fixture uses.
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch { /* no env file — the checks below report it */ }

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !KEY) {
  console.error('\n⛔ This report needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  console.error('   The anon key cannot see another tenant\'s rows through RLS, so a partial')
  console.error('   run would report a partial book as the whole book — which is worse than')
  console.error('   no report. Refusing rather than under-counting.\n')
  console.error('   The classification rules themselves are proven without a database:')
  console.error('     npm run verify:unpriced-work        (section 8c)\n')
  process.exit(2)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

// The classifier, imported from the app so the report and the product cannot
// disagree about what a $0 row means.
const { classifyLegacyZero } = await import('../src/lib/pricingState.ts')

const page = async (table, cols, filter) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    let qy = sb.from(table).select(cols).range(from, from + 999)
    if (filter) qy = filter(qy)
    const { data, error } = await qy
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

console.log('\n══ Reconciliation: existing zero / unpriced records ══\n')
console.log('READ-ONLY. Nothing below is modified.\n')

// ── Quotes ───────────────────────────────────────────────────────────────────
// `total` is GENERATED over initial_price, so an unpriced quote genuinely has
// NULL here. Both NULL and 0 are candidates.
const quotes = await page('quotes', 'id, quote_number, customer_name, status, total, initial_price, created_at, notes, internal_notes')
const quoteCandidates = quotes.filter(q => q.total == null || Number(q.total) === 0)

// ── Jobs ─────────────────────────────────────────────────────────────────────
// ⚠️ A job with `price = null` is NOT a candidate on its own — that is the normal
// "follow the quote" state. Only a job whose quote ALSO carries no price is
// genuinely unpriced, so the quote is joined in rather than assumed.
const jobs = await page('jobs', 'id, title, status, price, quote_id, completed_at, notes, created_at')
const quoteById = Object.fromEntries(quotes.map(q => [q.id, q]))
const jobCandidates = jobs.filter(j => {
  if (Number(j.price) > 0) return false
  const q = j.quote_id ? quoteById[j.quote_id] : null
  if (q && (Number(q.total) > 0 || Number(q.initial_price) > 0)) return false
  return true
})

// Invoices / payments, so "was money involved" is a fact rather than a guess.
const invoices = await page('invoices', 'id, job_id, quote_id, amount, amount_paid, status')
const invByJob = new Set(invoices.map(i => i.job_id).filter(Boolean))
const invByQuote = new Set(invoices.map(i => i.quote_id).filter(Boolean))
const paidJob = new Set(invoices.filter(i => Number(i.amount_paid) > 0).map(i => i.job_id).filter(Boolean))
const paidQuote = new Set(invoices.filter(i => Number(i.amount_paid) > 0).map(i => i.quote_id).filter(Boolean))

const tally = { legitimate_free: [], likely_unpriced: [], ambiguous: [] }

for (const q of quoteCandidates) {
  const { klass, why } = classifyLegacyZero({
    amount: q.total,
    completed: ['completed', 'paid'].includes(q.status),
    hasInvoice: invByQuote.has(q.id),
    hasPayment: paidQuote.has(q.id),
    note: [q.notes, q.internal_notes].filter(Boolean).join(' · '),
    no_charge_at: q.no_charge_at, no_charge_reason: q.no_charge_reason, no_charge_by: q.no_charge_by,
  })
  tally[klass].push({ kind: 'quote', ref: q.quote_number ?? q.id, who: q.customer_name, status: q.status, why })
}

for (const j of jobCandidates) {
  const { klass, why } = classifyLegacyZero({
    amount: j.price,
    completed: j.status === 'completed',
    hasInvoice: invByJob.has(j.id),
    hasPayment: paidJob.has(j.id),
    note: j.notes,
    no_charge_at: j.no_charge_at, no_charge_reason: j.no_charge_reason, no_charge_by: j.no_charge_by,
  })
  tally[klass].push({ kind: 'visit', ref: j.id.slice(0, 8), who: j.title, status: j.status, why })
}

const N = (a) => String(a.length).padStart(5)
console.log(`  quotes scanned  ${String(quotes.length).padStart(5)}   candidates ${N(quoteCandidates)}`)
console.log(`  visits scanned  ${String(jobs.length).padStart(5)}   candidates ${N(jobCandidates)}\n`)
console.log('  ── classification ──')
console.log(`  legitimate free  ${N(tally.legitimate_free)}   complete no-charge record — nothing to do`)
console.log(`  likely unpriced  ${N(tally.likely_unpriced)}   no price and no evidence anyone decided it was free`)
console.log(`  ambiguous        ${N(tally.ambiguous)}   ⛔ ASK A HUMAN — evidence points both ways\n`)

for (const k of ['ambiguous', 'likely_unpriced', 'legitimate_free']) {
  if (!tally[k].length) continue
  console.log(`\n── ${k} (${tally[k].length}) ──`)
  for (const r of tally[k].slice(0, 40)) {
    console.log(`  ${r.kind.padEnd(5)} ${String(r.ref).padEnd(14)} ${String(r.who ?? '').slice(0, 28).padEnd(28)} ${r.status.padEnd(10)} ${r.why}`)
  }
  if (tally[k].length > 40) console.log(`  … and ${tally[k].length - 40} more (see the JSON)`)
}

const out = 'unpriced-reconciliation.json'
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), tally }, null, 2))
console.log(`\n  full report → ${out}`)
console.log('\n⛔ NOTHING WAS MODIFIED. Deciding what an ambiguous row meant is the owner\'s')
console.log('   call, one row at a time, using the No charge action — not a bulk update.\n')
