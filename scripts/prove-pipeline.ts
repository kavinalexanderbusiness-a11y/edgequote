// ── Production proof: the pipeline against the real book ─────────────────────
//   npx tsx scripts/prove-pipeline.ts
//
// Signs in as a real tenant and runs THE loader (lib/pipelineData → the same
// query batch the page uses) and THE engine against live production rows. Then
// it independently re-derives, straight from the raw tables, what the answer
// OUGHT to be, and fails if the engine disagrees.
//
// READ-ONLY. It writes nothing, and it is dev tooling: `next build` never
// invokes it. It exists because a green unit suite proves the engine is
// self-consistent on fixtures, not that it survives a real book — the shapes
// fixtures never contain (a quote with no customer, an invoice with a deposit
// left over from an edit, a lead whose customer was merged away).

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPipeline } from '../src/lib/pipelineData'
import { STAGE_ORDER, STAGE_LABELS, isWon, isLost } from '../src/lib/salesStage'
import { formatCurrency } from '../src/lib/utils'

// .env.local, parsed here rather than pulled in via next — this runs under tsx.
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const WHO = process.argv[2] === 'owner' ? 'owner' : 'fixture'
const EMAIL = WHO === 'owner' ? process.env.PORTAL_RPC_OWNER_EMAIL! : process.env.VERIFY_FIXTURE_EMAIL!
const PASSWORD = WHO === 'owner' ? process.env.PORTAL_RPC_OWNER_PASSWORD! : process.env.VERIFY_FIXTURE_PASSWORD!

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))

async function main() {
  const sb = createClient(URL, ANON)
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (authErr || !auth.user) throw new Error(`sign-in failed for the ${WHO} tenant: ${authErr?.message}`)
  const uid = auth.user.id
  console.log(`\nSigned in as the ${WHO} tenant (${EMAIL})`)

  // ── THE loader, exactly as the page calls it ──
  const t0 = Date.now()
  const report = await loadPipeline(sb, uid)
  const ms = Date.now() - t0

  console.log(`\n─ The board, from live production rows (${ms}ms) ─`)
  console.log(`  ${report.items.length} deals · ${report.actionable} need something today · ${formatCurrency(report.openValue)} open`)
  for (const s of STAGE_ORDER) {
    if (report.counts[s]) console.log(`  ${STAGE_LABELS[s].padEnd(14)} ${report.counts[s]}`)
  }
  console.log('\n─ Top of the queue ─')
  for (const o of report.items.slice(0, 12)) {
    const money = o.value != null ? formatCurrency(o.value) : '—'
    console.log(`  ${STAGE_LABELS[o.stage].padEnd(14)} ${o.name.slice(0, 22).padEnd(23)} ${money.padStart(10)}  →  ${o.action.label} (${o.action.detail})`)
  }

  // ══ Independent re-derivation from the raw tables ══════════════════════════
  // Not a re-run of the engine: these read production directly and assert the
  // facts the board is CLAIMING. A board that agrees with itself proves nothing.
  console.log('\n─ Does the board match the database? ─')

  const [qRes, jRes, iRes, oRes] = await Promise.all([
    sb.from('quotes').select('id, status, total, customer_id').eq('user_id', uid),
    sb.from('jobs').select('quote_id, status').eq('user_id', uid),
    sb.from('invoices').select('id, quote_id, status, amount, amount_paid').eq('user_id', uid),
    sb.from('quote_outcomes').select('quote_id, reason').eq('user_id', uid),
  ])
  for (const [name, r] of [['quotes', qRes], ['jobs', jRes], ['invoices', iRes], ['outcomes', oRes]] as const) {
    if (r.error) throw new Error(`${name} read failed: ${r.error.message}`)
  }
  const quotes = qRes.data!
  const booked = new Set(jRes.data!.filter(j => j.quote_id && j.status !== 'cancelled').map(j => j.quote_id))
  const tagged = new Set(oRes.data!.map(o => o.quote_id))

  console.log(`  (book: ${quotes.length} quotes · ${jRes.data!.length} jobs · ${iRes.data!.length} invoices · ${oRes.data!.length} tagged losses)`)

  // 1 · Every DRAFT is on the board, exactly once.
  const drafts = quotes.filter(q => q.status === 'draft')
  const draftRows = report.items.filter(o => o.stage === 'quote_draft')
  check(`every draft quote is on the board (${drafts.length})`,
    draftRows.length === drafts.length,
    `database says ${drafts.length} drafts, board shows ${draftRows.length}`)

  // 2 · Every SENT quote is on the board.
  const sent = quotes.filter(q => q.status === 'sent')
  const sentRows = report.items.filter(o => o.stage === 'quote_sent')
  check(`every sent quote is on the board (${sent.length})`,
    sentRows.length === sent.length,
    `database says ${sent.length} sent, board shows ${sentRows.length}`)

  // 3 · ⭐ THE regression the customer profile shipped: an approved quote that is
  //     already booked must NOT be asked to be scheduled.
  const bookedWon = quotes.filter(q => isWon(q.status) && booked.has(q.id))
  const wrongly = report.items.filter(o => o.action.kind === 'schedule_work' && o.quoteId && booked.has(o.quoteId))
  check(`no booked deal is told to schedule itself (${bookedWon.length} booked wins)`,
    wrongly.length === 0,
    `${wrongly.map(o => o.name).join(', ')} — these already have a job`)

  // 4 · …and every approved quote with NO job IS asked.
  const unbookedAccepted = quotes.filter(q => q.status === 'accepted' && !booked.has(q.id))
  const asked = new Set(report.items.filter(o => o.action.kind === 'schedule_work').map(o => o.quoteId))
  const missedBooking = unbookedAccepted.filter(q => !asked.has(q.id))
  check(`every unbooked approved quote asks to be scheduled (${unbookedAccepted.length})`,
    missedBooking.length === 0,
    `${missedBooking.map(q => q.id).join(', ')} — approved with no job and no prompt`)

  // 5 · A tagged loss never asks again; an untagged one does.
  const lost = quotes.filter(q => isLost(q.status))
  const lostOnBoard = report.items.filter(o => o.stage === 'lost')
  const untagged = lost.filter(q => !tagged.has(q.id))
  check(`only untagged losses ask for a reason (${untagged.length} of ${lost.length})`,
    lostOnBoard.length === untagged.length,
    `${untagged.length} untagged in the database, ${lostOnBoard.length} on the board`)
  check('every loss on the board is genuinely optional',
    lostOnBoard.every(o => o.action.optional === true))

  // 6 · No deal is represented twice — the dedupe rule, on real data.
  const keys = report.items.map(o => o.key)
  check('no deal appears twice', new Set(keys).size === keys.length)
  const custs = report.items.filter(o => o.customerId).map(o => o.customerId!)
  const dupCust = custs.filter((c, n) => custs.indexOf(c) !== n)
  // A customer CAN legitimately hold several quotes; what must never happen is a
  // lead row beside a quote row for the same person.
  const leadDup = report.items.filter(o => o.source === 'lead' && o.customerId && dupCust.includes(o.customerId))
  check('no lead sits beside a quote for the same customer', leadDup.length === 0,
    `${leadDup.map(o => o.name).join(', ')} — the quote IS the response to the lead`)

  // 7 · Money on the board is money in the ledger — never a $0 phantom.
  check('no deal renders as a $0 deal', report.items.every(o => o.value == null || o.value > 0),
    'an unpriced deal must be null (unknown), never zero')

  // 8 · The ranking actually holds on real data.
  const scores = report.items.map(o => o.score)
  check('the board is sorted', scores.every((s, n) => n === 0 || scores[n - 1] >= s))

  // 9 · Every row can be acted on: the href must point somewhere real.
  const badHref = report.items.filter(o => !o.href.startsWith('/') || !o.action.href.startsWith('/'))
  check('every row and every action links somewhere', badHref.length === 0,
    badHref.map(o => `${o.name}: ${o.href} / ${o.action.href}`).join('; '))

  await sb.auth.signOut({ scope: 'local' })

  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ prove-pipeline (${WHO}) — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log(`\n✅ prove-pipeline (${WHO}) — the board matches the live database\n`)
}

main().catch(e => { console.error('\n❌ ' + (e?.message || e) + '\n'); process.exit(1) })
