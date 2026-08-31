// ── READ-ONLY audit: what is the Growth advisor actually reasoning from? ─────
//   node scripts/growth-evidence-audit.mjs
//
// ⛔⛔ READ-ONLY. Every statement is a SELECT. This script performs no insert,
// update, delete or RPC, and it is the reason the quality thresholds in
// lib/growthEvidence are measured rather than invented — the brief is explicit:
// "Do not invent arbitrary caps without measuring current data first."
//
// It answers, against the real book:
//   1. How much of the completed-visit evidence is UNPRICED or $0?
//   2. How many customers have a DECLARED cadence, versus one the engine assumes?
//   3. What does the visit-value distribution look like (mean vs median, outliers)?
//   4. What is `summary.totalOpportunity` made of, and what survives a gate?
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const E = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: E.PORTAL_RPC_OWNER_EMAIL, password: E.PORTAL_RPC_OWNER_PASSWORD,
})
if (error) { console.error('login failed:', error.message); process.exit(1) }
const uid = auth.user.id

const pct = (n, d) => d ? `${Math.round((n / d) * 1000) / 10}%` : '—'
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo) }
const median = a => q(a, 0.5)
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
const money = n => n == null ? '—' : `$${Math.round(n).toLocaleString()}`

const [{ data: jobs }, { data: recs }, { data: quotes }, { data: custs }] = await Promise.all([
  sb.from('jobs').select('id,customer_id,recurrence_id,scheduled_date,status,service_type,price,quote_id,is_initial_visit').eq('user_id', uid),
  sb.from('job_recurrences').select('id,freq,interval_unit,interval_count,customer_id,start_date,end_date').eq('user_id', uid),
  sb.from('quotes').select('id,initial_price,total,weekly_price,biweekly_price,monthly_price').eq('user_id', uid),
  sb.from('customers').select('id,name,created_at').eq('user_id', uid),
])
const qById = Object.fromEntries((quotes || []).map(x => [x.id, x]))
const recById = Object.fromEntries((recs || []).map(x => [x.id, x]))

console.log(`\n══ BOOK ══`)
console.log(`customers ${custs?.length ?? 0} · jobs ${jobs?.length ?? 0} · recurrences ${recs?.length ?? 0} · quotes ${quotes?.length ?? 0}`)

// ── 1. How much completed evidence carries no price at all? ─────────────────
const completed = (jobs || []).filter(j => j.status === 'completed')
const effFreq = r => {
  if (!r) return null
  if (r.freq) return r.freq
  const u = r.interval_unit, c = Number(r.interval_count) || 1
  if (u === 'week') return c === 1 ? 'weekly' : c === 2 ? 'biweekly' : null
  if (u === 'month') return c === 1 ? 'monthly' : null
  if (u === 'day') return c === 7 ? 'weekly' : c === 14 ? 'biweekly' : null
  return null
}
const quoteAmt = (quote, freq) => {
  if (!quote) return 0
  const byFreq = freq === 'weekly' ? Number(quote.weekly_price) : freq === 'biweekly' ? Number(quote.biweekly_price) : freq === 'monthly' ? Number(quote.monthly_price) : NaN
  if (Number.isFinite(byFreq) && byFreq > 0) return byFreq
  if (freq) { const any = [quote.weekly_price, quote.biweekly_price, quote.monthly_price].map(Number).find(n => Number.isFinite(n) && n > 0); if (any) return any }
  return Number(quote.initial_price) || Number(quote.total) || 0
}
// The engine's own definition, replicated exactly (lib/visitValue jobVisitValue).
const visitValue = j => {
  const p = Number(j.price)
  if (Number.isFinite(p) && p > 0) return p
  const freq = j.recurrence_id ? effFreq(recById[j.recurrence_id]) : null
  return quoteAmt(j.quote_id ? qById[j.quote_id] : null, j.is_initial_visit ? null : freq)
}
let priced = 0, zeroPrice = 0, noPriceNoQuote = 0
const values = []
for (const j of completed) {
  const v = visitValue(j)
  if (v > 0) { priced++; values.push(v) }
  else {
    // Distinguish "the owner wrote 0" from "nobody ever said" — S114's whole point.
    const explicitZero = Number(j.price) === 0 && j.price !== null
    if (explicitZero) zeroPrice++; else noPriceNoQuote++
  }
}
console.log(`\n══ 1. COMPLETED-VISIT EVIDENCE (${completed.length}) ══`)
console.log(`  priced (>0)          ${priced}  ${pct(priced, completed.length)}`)
console.log(`  explicit $0          ${zeroPrice}  ${pct(zeroPrice, completed.length)}   ⛔ counted as REAL revenue of $0 today`)
console.log(`  UNPRICED (no signal) ${noPriceNoQuote}  ${pct(noPriceNoQuote, completed.length)}   ⛔ ALSO valued 0 — unknown is not free`)
console.log(`  ⇒ ${pct(zeroPrice + noPriceNoQuote, completed.length)} of completed visits contribute $0 to every LTV-derived figure`)

// ── 2. Declared cadence vs assumed ──────────────────────────────────────────
const custWithRec = new Set()
const custDeclared = new Set()
for (const j of jobs || []) {
  if (!j.recurrence_id || !j.customer_id) continue
  custWithRec.add(j.customer_id)
  if (effFreq(recById[j.recurrence_id])) custDeclared.add(j.customer_id)
}
const custCompleted = new Set(completed.map(j => j.customer_id).filter(Boolean))
console.log(`\n══ 2. CADENCE EVIDENCE ══`)
console.log(`  customers with any completed visit   ${custCompleted.size}`)
console.log(`  …of those, attached to a recurrence  ${[...custCompleted].filter(c => custWithRec.has(c)).length}`)
console.log(`  …with a DECLARED cadence             ${[...custCompleted].filter(c => custDeclared.has(c)).length}`)
const assumed = [...custCompleted].filter(c => !custDeclared.has(c)).length
console.log(`  ⛔ NO declared cadence               ${assumed}  ${pct(assumed, custCompleted.size)}`)
console.log(`     → today these are annualized at SEASON_VISITS.biweekly = 14 anyway`)
const noFreq = (recs || []).filter(r => !effFreq(r)).length
console.log(`  recurrences whose cadence does not resolve: ${noFreq} / ${recs?.length ?? 0}  ⇒ visitsPerSeason(null) → 14`)

// ── 3. The distribution — is a mean safe here? ──────────────────────────────
console.log(`\n══ 3. VISIT-VALUE DISTRIBUTION (priced visits only, n=${values.length}) ══`)
if (values.length) {
  const m = median(values), mn = mean(values)
  const p90 = q(values, 0.9), p99 = q(values, 0.99), max = Math.max(...values)
  console.log(`  min ${money(Math.min(...values))} · p25 ${money(q(values, 0.25))} · MEDIAN ${money(m)} · p75 ${money(q(values, 0.75))} · p90 ${money(p90)} · p99 ${money(p99)} · max ${money(max)}`)
  console.log(`  mean ${money(mn)}   ⇒ mean/median ratio ${(mn / m).toFixed(2)}×`)
  // MAD — the robust spread. A normal-ish sample has MAD ≈ 0.67σ; outliers barely move it.
  const mad = median(values.map(v => Math.abs(v - m)))
  const madCut = m + 5 * (mad || 1)
  console.log(`  MAD ${money(mad)} · median + 5·MAD = ${money(madCut)} → ${values.filter(v => v > madCut).length} visit(s) above it`)
  console.log(`  max is ${(max / m).toFixed(1)}× the median — one such visit in a small sample moves a mean hard`)
}

// ── 4. What the headline is made of ─────────────────────────────────────────
const perCust = {}
for (const j of completed) {
  if (!j.customer_id) continue
  ;(perCust[j.customer_id] ||= { n: 0, ltv: 0 })
  perCust[j.customer_id].n++
  perCust[j.customer_id].ltv += visitValue(j)
}
let annualizedFromNothing = 0, annualizedCust = 0, wouldSurvive = 0
for (const [cid, a] of Object.entries(perCust)) {
  const declared = custDeclared.has(cid)
  if (!declared && a.n >= 1 && a.ltv > 0) { annualizedFromNothing += Math.round((a.ltv / a.n) * 14); annualizedCust++ }
  if (declared && a.ltv > 0) wouldSurvive++
}
console.log(`\n══ 4. WHAT THE "/yr" HEADLINE IS BUILT FROM ══`)
console.log(`  customers annualized at ×14 with NO declared cadence : ${annualizedCust}`)
console.log(`  $ those contribute if each fired one recommendation   : ${money(annualizedFromNothing)}`)
console.log(`  customers WITH a declared cadence and real value      : ${wouldSurvive}`)
const singles = Object.values(perCust).filter(a => a.n === 1).length
console.log(`  customers with exactly ONE completed visit            : ${singles}  ⛔ ×14 turns one visit into a year`)

// ── 5. Fixture contamination ────────────────────────────────────────────────
// ⚠️ NO fixture marker exists in the schema (S113). A NAME rule over REAL ROWS is
// the only available signal, and it must be read as a FLAG for the owner, never
// as silent classification.
const FIXTURE_RX = /\b(fixture|test|demo|sample|dummy|example|delete me|do not use|zz[\s-])/i
const flagged = (custs || []).filter(c => FIXTURE_RX.test(c.name || ''))
console.log(`\n══ 5. FIXTURE / TEST CONTAMINATION (name signal only) ══`)
console.log(`  customers whose NAME reads as a fixture: ${flagged.length}`)
for (const c of flagged.slice(0, 12)) console.log(`    · ${c.name}`)
const flaggedJobs = completed.filter(j => flagged.some(c => c.id === j.customer_id)).length
console.log(`  completed visits belonging to them     : ${flaggedJobs}`)
const svcFlagged = new Set(completed.filter(j => FIXTURE_RX.test(j.service_type || '')).map(j => j.service_type))
console.log(`  completed visits whose SERVICE name reads as a fixture: ${completed.filter(j => FIXTURE_RX.test(j.service_type || '')).length}`)
for (const s of [...svcFlagged].slice(0, 8)) console.log(`    · ${s}`)

console.log('\n⛔ read-only: no insert/update/delete/rpc was issued.\n')
process.exit(0)
