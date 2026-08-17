/**
 * verify-sales-analytics — Sales Analytics + Pipeline Forecasting V1.
 *
 * Run: npx tsx scripts/verify-sales-analytics.ts  ·  npm run verify:sales-analytics
 *
 * This report states dollar figures about a business's selling. Every one of
 * them is a sentence an owner will act on, and most of the ways it can be wrong
 * are invisible — a number that is 30% too high looks exactly like a number that
 * is right. So the claims are asserted here rather than trusted:
 *
 *   1. RECONCILIATION. Every headline figure re-derives from the raw rows by an
 *      INDEPENDENT path — not by calling the engine again. If the engine and the
 *      hand-derived answer disagree, one of them is wrong and the run is red.
 *   2. THE FIVE FIGURES STAY FIVE. quoted / won / authorized / invoiced /
 *      collected are different questions. A fixture where all five differ pins
 *      that none of them has quietly collapsed into another.
 *   3. NOTHING IS INFERRED BACKWARDS. quotes has no accepted_at; the report is a
 *      cohort by creation date and must never grow a fake decision date.
 *   4. A CANCELLED INVOICE KEEPS ITS BALANCE — and must stay out of invoiced and
 *      out of outstanding. The money guard that has bitten this codebase before.
 *   5. A REFUND IS NOT A NEGATIVE PAYMENT ROW TO IGNORE, and a credit settlement
 *      is not new cash. Both go through cashAmountOf or the figure is inflated.
 *   6. A DRAFT IS NOT A QUOTE, an unpriced deal is NULL and never $0, and a
 *      pending change order is not authorized money.
 *   7. UNKNOWN STAYS UNKNOWN. A blank lead source never becomes a channel, and
 *      the residual is never dropped from the source table.
 *   8. RATES ARE WITHHELD ON TINY SAMPLES — counts always, percentages only
 *      above the floor lib/attribution already set.
 *   9. TENANCY IS PER READ. The loader's every read carries an explicit
 *      user_id filter; asserted per `.from(` block, never as a file-wide count.
 *  10. NO SECOND ENGINE. The module imports the canonical rules and defines
 *      none of its own — pinned statically, because a copied predicate is how
 *      two screens start disagreeing about what "won" means.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeSalesAnalytics, presetPeriod, customPeriod, dealValue, PERIOD_PRESETS,
  type SAQuote, type SAInvoice, type SAPayment, type SAChangeOrder, type SACustomer, type SAJob,
  type SalesAnalyticsInput,
} from '../src/lib/sales/analytics'
import { isWon, isLost } from '../src/lib/salesStage'
import { invoiceTotals } from '../src/lib/invoiceTotals'
import { invoiceBalance } from '../src/lib/payments/ledger'
import { cashAmountOf } from '../src/lib/payments/analytics'
import { MIN_SAMPLE_FOR_RATE } from '../src/lib/attribution'
import { FOLLOW_UP_DAYS } from '../src/lib/followup'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`) }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  check(name, a === e, `expected ${e}, got ${a}`)
}
/** Money compare — the engine rounds to cents, so exact equality is the bar. */
function money(name: string, actual: number, expected: number) {
  check(name, Math.abs(actual - expected) < 0.005, `expected ${expected}, got ${actual}`)
}

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed — what the CODE says, not what it explains.
 *
 * ⚠️⚠️ Every static check below MUST run on this, not on the raw file. This
 * module documents the traps it avoids, so the raw text contains `updated_at`,
 * `accepted_at` and `.billable` in the very sentences promising not to use them
 * — and a bare `/tip/i` matches the "mul·tip·ly" in a comment about recurring
 * visits. A guard that reads prose reports the opposite of the truth.
 *
 * ⚠️ LINE comments first, then block comments, and `[^\n]` rather than `.` —
 * with CRLF checkouts `.` does not match `\r`, so a trailing-comment strip
 * leaves the carriage return behind and a later anchored match fails for no
 * visible reason.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

// ═════════════════════════════════════════════════════════════════════════════
// THE FIXTURE — one book, deliberately containing every shape the brief names
// ═════════════════════════════════════════════════════════════════════════════
//
// Hand-derived expectations live beside each row so the arithmetic is auditable
// without running anything. The clock is FIXED: 2026-08-16T12:00:00Z.

const NOW = Date.parse('2026-08-16T12:00:00Z')
const PERIOD = customPeriod('2026-07-01', '2026-08-16')
const day = (d: string) => `${d}T09:00:00.000Z`

const Q = (over: Partial<SAQuote> & { id: string; status: string }): SAQuote => ({
  quote_number: `Q-${over.id}`, customer_id: null, customer_name: 'Someone',
  service_type: 'Mowing', total: 100, accepted_price: null,
  created_at: day('2026-07-10'), sent_at: day('2026-07-10'), last_followed_up_at: null,
  ...over,
})

// ── The quotes ───────────────────────────────────────────────────────────────
const quotes: SAQuote[] = [
  // 1 · PLAIN WON quote. No acceptance snapshot → counts at `total`.        1200
  Q({ id: 'won-plain', status: 'accepted', total: 1200, customer_id: 'c-google' }),
  // 2 · QUOTE OPTIONS: the customer chose an option cheaper than the
  //     recommended price the quote was reported at while open. The acceptance
  //     snapshot is what they AGREED to, so it wins.                     → 900
  Q({ id: 'won-options', status: 'accepted', total: 1500, accepted_price: 900, customer_id: 'c-fb' }),
  // 3 · WON + CHANGE ORDERS (one approved 250, one pending 400).          → 500
  Q({ id: 'won-changed', status: 'accepted', total: 500, customer_id: 'c-ref' }),
  // 4 · LOST.                                                             → 300
  Q({ id: 'lost-one', status: 'declined', total: 300, customer_id: 'c-google' }),
  // 5 · DRAFT — never left the desk. Not "quoted".                        → 700
  Q({ id: 'draft-one', status: 'draft', total: 700, customer_id: 'c-unknown' }),
  // 6 · OPEN, gone QUIET (sent 20 days ago) → follow-up needed.           → 400
  Q({ id: 'open-quiet', status: 'sent', total: 400, sent_at: day('2026-07-27'), customer_id: 'c-fb' }),
  // 7 · OPEN, sent TODAY → awaiting the customer, not a chase.            → 250
  Q({ id: 'open-fresh', status: 'sent', total: 250, sent_at: '2026-08-16T08:00:00.000Z', customer_id: 'c-nd' }),
  // 8 · UNPRICED draft. NULL, never $0.                                   →   0
  Q({ id: 'draft-unpriced', status: 'draft', total: null, customer_id: 'c-unknown' }),
]

const jobs: SAJob[] = [
  { id: 'j-changed', quote_id: 'won-changed', customer_id: 'c-ref' },
  { id: 'j-plain', quote_id: 'won-plain', customer_id: 'c-google' },
  // A job with NO quote — its change order must not reach any deal.
  { id: 'j-orphan', quote_id: null, customer_id: 'c-google' },
]

const changeOrders: SAChangeOrder[] = [
  { id: 'co-1', job_id: 'j-changed', status: 'approved', amount: 250 },
  { id: 'co-2', job_id: 'j-changed', status: 'pending', amount: 400 },
  { id: 'co-3', job_id: 'j-changed', status: 'declined', amount: 999 },
  // Attached to a quote-less job: invisible to this report by construction.
  { id: 'co-orphan', job_id: 'j-orphan', status: 'approved', amount: 5000 },
]

const invoices: SAInvoice[] = [
  // PARTIAL INVOICE: 1200 won, only 700 billed so far.
  { id: 'inv-plain', invoice_number: 'INV-1', quote_id: 'won-plain', job_id: null, customer_id: 'c-google', status: 'partial', amount: 700, amount_paid: 300 },
  // Reached through the JOB, not the quote — the transitive weld.
  { id: 'inv-changed', invoice_number: 'INV-2', quote_id: null, job_id: 'j-changed', customer_id: 'c-ref', status: 'sent', amount: 750, amount_paid: 0 },
  // CANCELLED — keeps its balance in the ledger, must stay out of both figures.
  { id: 'inv-cancelled', invoice_number: 'INV-3', quote_id: 'won-options', job_id: null, customer_id: 'c-fb', status: 'cancelled', amount: 900, amount_paid: 0 },
  // DRAFT — money not yet ASKED for.
  { id: 'inv-draft', invoice_number: 'INV-4', quote_id: 'won-options', job_id: null, customer_id: 'c-fb', status: 'draft', amount: 400, amount_paid: 0 },
  // Another business's invoice, welded to nothing here.
  { id: 'inv-foreign', invoice_number: 'INV-X', quote_id: 'foreign-quote', job_id: null, customer_id: 'c-foreign', status: 'sent', amount: 9999, amount_paid: 0 },
]

const payments: SAPayment[] = [
  // PARTIAL PAYMENT against inv-plain.                                   +300
  { id: 'p-1', invoice_id: 'inv-plain', customer_id: 'c-google', kind: 'payment', provider: 'stripe', status: 'paid', amount: 300 },
  // REFUND — kind 'payment', provider 'refund', amount NEGATIVE.         −120
  { id: 'p-2', invoice_id: 'inv-plain', customer_id: 'c-google', kind: 'payment', provider: 'refund', status: 'paid', amount: -120 },
  // DEPOSIT taken against the BOOKING, before any invoice existed.       +200
  { id: 'p-3', invoice_id: null, quote_id: 'won-changed', customer_id: 'c-ref', kind: 'payment', provider: 'etransfer', status: 'paid', amount: 200 },
  // …and its credit-ledger leg. NOT cash — counting it doubles the deposit.
  { id: 'p-4', invoice_id: null, quote_id: 'won-changed', customer_id: 'c-ref', kind: 'credit', provider: 'etransfer', status: 'paid', amount: 200 },
  // Settling an invoice FROM that credit. Real settlement, but the cash
  // arrived at p-3 — provider='credit' keeps it out.
  { id: 'p-5', invoice_id: 'inv-changed', customer_id: 'c-ref', kind: 'payment', provider: 'credit', status: 'paid', amount: 200 },
  // PENDING — not yet money.
  { id: 'p-6', invoice_id: 'inv-plain', customer_id: 'c-google', kind: 'payment', provider: 'stripe', status: 'pending', amount: 500 },
  // Another business's payment.
  { id: 'p-foreign', invoice_id: 'inv-foreign', customer_id: 'c-foreign', kind: 'payment', provider: 'stripe', status: 'paid', amount: 9999 },
]

const customers: SACustomer[] = [
  { id: 'c-google', acquisition_source: 'Google', created_at: day('2026-07-02') },
  { id: 'c-fb', acquisition_source: 'Facebook', created_at: day('2026-07-03') },
  { id: 'c-ref', acquisition_source: 'Referral from a friend', created_at: day('2026-07-04') },
  { id: 'c-nd', acquisition_source: 'Nextdoor', created_at: day('2026-07-05') },
  // UNKNOWN LEAD SOURCE — blank. Must stay `unknown`, never become a channel.
  { id: 'c-unknown', acquisition_source: null, created_at: day('2026-07-06') },
  // Arrived in the period, never quoted → an unquoted lead.
  { id: 'c-lead-only', acquisition_source: '   ', created_at: day('2026-08-01') },
]

const INPUT: SalesAnalyticsInput = {
  quotes, jobs, invoices, payments, changeOrders, customers,
  // 0% GST and no fee recovery — this business is not a registrant, which is the
  // live configuration. invoiceTotals then returns total === amount.
  feeSettings: { gst_percent: 0, payment_fee_strategy: null, fee_recovery_percent: null },
  period: PERIOD,
  nowMs: NOW,
}

const R = computeSalesAnalytics(INPUT)
const S = R.snapshot

// ═════════════════════════════════════════════════════════════════════════════
H('1 · The five money figures — hand-derived, and all different')
// ═════════════════════════════════════════════════════════════════════════════
// quoted  = every non-draft: 1200 + 900(accepted snapshot) + 500 + 300 + 400 + 250
// Note won-options counts at 900 even in `quoted`, because dealValue asks what
// the deal is worth NOW and the customer has chosen.
money('quoted = 3,550', S.quoted, 1200 + 900 + 500 + 300 + 400 + 250)
eq('quotedCount = 6 (drafts excluded)', S.quotedCount, 6)
money('draft = 700 (held apart, never in quoted)', S.draft, 700)
eq('draftCount = 2 (the unpriced one counts as a record)', S.draftCount, 2)

money('open = 650 (awaiting a decision)', S.open, 400 + 250)
eq('openCount = 2', S.openCount, 2)
money('won = 2,600', S.won, 1200 + 900 + 500)
eq('wonCount = 3', S.wonCount, 3)
money('lost = 300', S.lost, 300)
eq('lostCount = 1', S.lostCount, 1)

// authorized = won 2,600 + the ONE approved change order (250). Pending and
// declined changes are not authorized money.
money('authorized = 2,850 (won + approved changes only)', S.authorized, 2600 + 250)
money('approvedChanges = 250', S.approvedChanges, 250)
money('pendingChanges = 400 (reported, NOT authorized)', S.pendingChanges, 400)
eq('pendingChangeCount = 1', S.pendingChangeCount, 1)

// invoiced = issued, non-cancelled, non-draft: 700 + 750
money('invoiced = 1,450', S.invoiced, 700 + 750)
eq('invoicedCount = 2', S.invoicedCount, 2)
money('invoiceDraft = 400 (not yet asked for)', S.invoiceDraft, 400)
eq('cancelledCount = 1 (surfaced, not silently dropped)', S.cancelledCount, 1)

// collected = 300 (partial) + 200 (deposit). The credit leg, the credit
// settlement and the pending row are all excluded.
money('collected = 500', S.collected, 300 + 200)
money('refunded = 120', S.refunded, 120)
money('netCollected = 380', S.netCollected, 380)

check('all five figures differ — none has collapsed into another',
  new Set([S.quoted, S.won, S.authorized, S.invoiced, S.netCollected]).size === 5,
  `got ${JSON.stringify([S.quoted, S.won, S.authorized, S.invoiced, S.netCollected])}`)

// ═════════════════════════════════════════════════════════════════════════════
H('2 · Reconciliation — every figure re-derived by an INDEPENDENT path')
// ═════════════════════════════════════════════════════════════════════════════
// Not by calling the engine again: by walking the raw rows with the canonical
// predicates. This is the check that catches an engine that is internally
// consistent and externally wrong.

const rawWon = quotes.filter(q => isWon(q.status))
  .reduce((s, q) => s + (q.accepted_price != null && q.accepted_price > 0 ? q.accepted_price : Number(q.total) || 0), 0)
money('won reconciles to a raw walk of isWon()', S.won, rawWon)

const rawLost = quotes.filter(q => isLost(q.status)).reduce((s, q) => s + (Number(q.total) || 0), 0)
money('lost reconciles to a raw walk of isLost()', S.lost, rawLost)

// Invoiced, walked from the invoice rows through invoiceTotals — the same door
// the invoice screen uses. Cohort membership resolved by hand here.
const cohortQuoteIds = new Set(quotes.map(q => q.id))
const jobToQuote = new Map(jobs.filter(j => j.quote_id).map(j => [j.id, j.quote_id!]))
const inCohort = (inv: SAInvoice) =>
  (inv.quote_id != null && cohortQuoteIds.has(inv.quote_id)) ||
  (inv.job_id != null && cohortQuoteIds.has(jobToQuote.get(inv.job_id) ?? ''))
const rawInvoiced = invoices
  .filter(inv => inCohort(inv) && inv.status !== 'cancelled' && inv.status !== 'draft')
  .reduce((s, inv) => s + invoiceTotals(inv.amount, INPUT.feeSettings, { type: inv.discount_type, value: inv.discount_value }).total, 0)
money('invoiced reconciles through invoiceTotals()', S.invoiced, rawInvoiced)

const rawOutstanding = invoices
  .filter(inv => inCohort(inv) && inv.status !== 'cancelled' && inv.status !== 'draft')
  .reduce((s, inv) => {
    const b = invoiceBalance({ ...inv, amount_paid: inv.amount_paid ?? undefined }, INPUT.feeSettings).balance
    return s + (b > 0.01 ? b : 0)
  }, 0)
money('outstanding reconciles through invoiceBalance()', S.outstanding, rawOutstanding)
money('outstanding = 400 + 750', S.outstanding, (700 - 300) + 750)

// Collected, walked with cashAmountOf — THE definition of "this row is cash".
const cohortInvIds = new Set(invoices.filter(inCohort).map(i => i.id))
const rawCash = payments
  .filter(p => (p.invoice_id && cohortInvIds.has(p.invoice_id)) || (p.quote_id && cohortQuoteIds.has(p.quote_id)))
  .reduce((s, p) => s + cashAmountOf(p), 0)
money('netCollected reconciles through cashAmountOf()', S.netCollected, rawCash)

// The identity summarizeTransactions documents: sum(cashAmountOf) === net.
money('collected − refunded === the signed ledger sum', S.collected - S.refunded, rawCash)

// ═════════════════════════════════════════════════════════════════════════════
H('3 · The money traps this codebase has actually been bitten by')
// ═════════════════════════════════════════════════════════════════════════════
check('a CANCELLED invoice is excluded from invoiced',
  !String(S.invoiced).includes('900') && S.invoiced === 1450)
check('a CANCELLED invoice is excluded from outstanding (it keeps its balance)',
  S.outstanding === 1150,
  `900 would have leaked in; got ${S.outstanding}`)
check('a DRAFT invoice is not "invoiced"', S.invoiced === 1450 && S.invoiceDraft === 400)
check('a credit-LEDGER row is not cash (deposit counted once)',
  S.collected === 500, `p-4 would have made it 700; got ${S.collected}`)
check('an invoice settled FROM credit is not new cash',
  S.collected === 500, `p-5 would have made it 700; got ${S.collected}`)
check('a PENDING payment is not money', S.collected === 500)
check('a refund is money OUT, not an ignored row', S.refunded === 120 && S.netCollected === 380)
check('a PENDING change order is not authorized money',
  S.authorized === 2850, `400 would have leaked in; got ${S.authorized}`)
check('a DECLINED change order is not authorized money', S.authorized === 2850)
check('a change order on a quote-less job reaches no deal',
  S.authorized === 2850, `co-orphan's 5000 would have leaked in; got ${S.authorized}`)
check('another business\'s invoice never enters the cohort',
  S.invoiced === 1450 && S.outstanding === 1150)
check('another business\'s payment never enters collected', S.collected === 500)

// ⚠️ The recurring-series trap: authorizedValue is asked ONCE PER DEAL. If it
// were asked per VISIT and summed, a deal with two jobs would double.
const twoVisits = computeSalesAnalytics({
  ...INPUT,
  jobs: [...jobs, { id: 'j-changed-2', quote_id: 'won-changed', customer_id: 'c-ref' }],
})
money('a second visit on the same deal does NOT double its authorized value',
  twoVisits.snapshot.authorized, S.authorized)

// ═════════════════════════════════════════════════════════════════════════════
H('4 · Deterministic buckets — no invented probabilities')
// ═════════════════════════════════════════════════════════════════════════════
// The brief is explicit: prefer deterministic buckets, and never state an
// "expected revenue" figure without a defensible model. There is no such model
// here, so there is no such figure — the open money is split by the FOLLOW-UP
// CADENCE, which is a recorded fact about the quote, not a guess about the human.
eq('follow-up needed = 1 (quiet past the cadence)', S.followUpCount, 1)
money('follow-up value = 400', S.followUpValue, 400)
eq('awaiting customer = 1 (still inside the cadence)', S.awaitingCount, 1)
money('awaiting value = 250', S.awaitingValue, 250)
money('the two buckets partition `open` exactly', S.followUpValue + S.awaitingValue, S.open)
eq('…and so do their counts', S.followUpCount + S.awaitingCount, S.openCount)
check('the cadence comes from lib/followup, not a local constant',
  FOLLOW_UP_DAYS === 3, `FOLLOW_UP_DAYS moved to ${FOLLOW_UP_DAYS} — re-derive the fixture`)

const engineSrc = codeOnly(read('src/lib/sales/analytics.ts'))
for (const banned of ['expectedRevenue', 'forecastRevenue', 'probability', 'likelihood', 'winProbability']) {
  check(`the engine states no "${banned}"`, !engineSrc.includes(banned))
}
check('no weighted-pipeline maths (a stage multiplier is an invented model)',
  !/\*\s*0\.[0-9]/.test(engineSrc) && !/weight/i.test(engineSrc))

// ═════════════════════════════════════════════════════════════════════════════
H('5 · Nothing is inferred backwards')
// ═════════════════════════════════════════════════════════════════════════════
check('the engine never reads updated_at (it moves on ANY edit)',
  !engineSrc.includes('updated_at'))
check('the engine never invents an accepted_at',
  !/accepted_at|decided_at|declined_at|won_at/.test(engineSrc))
check('the cohort note tells the owner what a date filter here MEANS',
  R.cohortNote.includes('created in this period') && /never guessed|not.*guess/i.test(R.cohortNote),
  R.cohortNote)
check('movement is ordered newest-first',
  R.movement.every((m, idx) => idx === 0 || R.movement[idx - 1].at >= m.at))
// ⚠️ Ordering must follow the LAST REAL MOVEMENT, not the creation date. A quote
// raised in January and chased yesterday is today's news; ordering by created_at
// buries it under every newer quote nobody has touched. The fixture is built so
// the two anchors DISAGREE — otherwise the rule could be deleted and stay green.
{
  const stale = Q({ id: 'old-but-chased', status: 'sent', total: 100,
    created_at: day('2026-07-02'), sent_at: day('2026-07-02'),
    last_followed_up_at: '2026-08-16T11:00:00.000Z', customer_id: 'c-google' })
  const m = computeSalesAnalytics({ ...INPUT, quotes: [...quotes, stale] }).movement
  eq('a quote chased today leads movement, however old it is', m[0].quoteId, 'old-but-chased')
  check('…and it is ranked by the follow-up, not the creation date',
    m[0].at === '2026-08-16T11:00:00.000Z', m[0].at)
}
check('a quote with no sent_at does not retro-fill the sent rung',
  R.funnel.hasUnstampedSends === false)
const unstamped = computeSalesAnalytics({
  ...INPUT,
  quotes: [...quotes, Q({ id: 'won-nosend', status: 'accepted', total: 50, sent_at: null, customer_id: 'c-google' })],
})
check('…and when one exists, the funnel SAYS so rather than looking broken',
  unstamped.funnel.hasUnstampedSends === true)

// ═════════════════════════════════════════════════════════════════════════════
H('6 · Unpriced is NULL, never $0')
// ═════════════════════════════════════════════════════════════════════════════
eq('an unpriced draft has value null', dealValue(quotes.find(q => q.id === 'draft-unpriced')!), null)
eq('a zero total is also null (not a $0 deal)', dealValue(Q({ id: 'z', status: 'sent', total: 0 })), null)
eq('a won quote with a 0 acceptance snapshot falls back to total',
  dealValue(Q({ id: 'z2', status: 'accepted', total: 500, accepted_price: 0 })), 500)
eq('the leads rung carries NO dollar figure', R.funnel.stages.find(s => s.key === 'leads')!.value, null)
check('an unpriced deal does not drag `quoted` down',
  S.quoted === 3550, 'a $0 would have been summed in')

// ═════════════════════════════════════════════════════════════════════════════
H('7 · Lead sources — known, not-recorded, and no fake certainty')
// ═════════════════════════════════════════════════════════════════════════════
const src = R.sources
const rowOf = (k: string) => src.rows.find(r => r.category === k)
check('Google is present', !!rowOf('google'))
check('Facebook is present', !!rowOf('facebook'))
check('a booking-page phrase normalises to referral (lib/attribution, not a local map)',
  !!rowOf('referral'), `got ${src.rows.map(r => r.category).join(', ')}`)
check('Nextdoor is present', !!rowOf('nextdoor'))
eq('blank and whitespace sources are `unknown` — never a channel', rowOf('unknown')?.customers, 2)
check('`unknown` sorts LAST and is never dropped',
  src.rows[src.rows.length - 1].category === 'unknown')
eq('unknown is labelled "Not recorded", not "Other"', rowOf('unknown')?.label, 'Not recorded')

eq('every cohort customer is counted exactly once', src.customers, 6)
eq('known = 4', src.known, 4)
eq('not-recorded share is reported as a data-quality finding', src.unknownPct, 33)

money('Google won value = 1,200', rowOf('google')!.wonValue, 1200)
money('Facebook won value = 900 (the snapshot, not the 1,500 ask)', rowOf('facebook')!.wonValue, 900)
money('Referral collected = 200 (the deposit)', rowOf('referral')!.collected, 200)
money('Google collected = 180 (300 in, 120 back)', rowOf('google')!.collected, 300 - 120)
check('no source claims a rate on a tiny sample',
  src.rows.every(r => r.wonRate === null),
  `every cohort here is under ${MIN_SAMPLE_FOR_RATE}; got ${JSON.stringify(src.rows.map(r => [r.category, r.wonRate]))}`)
check('the sample floor is lib/attribution\'s, not a second opinion',
  src.minSampleForRate === MIN_SAMPLE_FOR_RATE)

// A cohort big enough DOES get a rate — otherwise the rule above is untestable.
const big: SACustomer[] = Array.from({ length: 12 }, (_, n) => ({
  id: `c-big-${n}`, acquisition_source: 'Google', created_at: day('2026-07-08'),
}))
const bigQuotes: SAQuote[] = big.slice(0, 6).map(c =>
  Q({ id: `q-big-${c.id}`, status: 'accepted', total: 100, customer_id: c.id }))
const bigRun = computeSalesAnalytics({ ...INPUT, customers: [...customers, ...big], quotes: [...quotes, ...bigQuotes] })
const bigGoogle = bigRun.sources.rows.find(r => r.category === 'google')!
check('a cohort at/above the floor DOES get a rate', bigGoogle.wonRate !== null)
money('…and it is won/customers', bigGoogle.wonRate!, bigGoogle.won / bigGoogle.customers)

// Source money must never multiply: one customer, many won quotes, counted once
// in the COUNT columns and summed once in the money columns.
const multi = computeSalesAnalytics({
  ...INPUT,
  quotes: [...quotes, Q({ id: 'won-plain-2', status: 'accepted', total: 40, customer_id: 'c-google' })],
})
const g2 = multi.sources.rows.find(r => r.category === 'google')!
eq('a customer with two won quotes still counts as ONE won customer', g2.won, 1)
money('…but both deals\' money is counted', g2.wonValue, 1240)

// ═════════════════════════════════════════════════════════════════════════════
H('8 · The funnel')
// ═════════════════════════════════════════════════════════════════════════════
const stage = (k: string) => R.funnel.stages.find(s => s.key === k)!
eq('six rungs, in the brief\'s order',
  R.funnel.stages.map(s => s.key),
  ['leads', 'quoted', 'won', 'authorized', 'invoiced', 'collected'])
eq('leads counts CUSTOMERS (4 quoted + 2 never quoted)', stage('leads').count, 6)
// c-lead-only was never quoted at all; c-unknown holds only DRAFTS, which never
// reached anyone. Both are people who came to this business and left without a
// quote — counting a draft as "quoted" would hide exactly the leads worth chasing.
eq('a customer holding only DRAFTS counts as an unquoted lead', R.funnel.unquotedLeads, 2)
money('the quoted rung equals the snapshot', stage('quoted').value!, S.quoted)
money('the won rung equals the snapshot', stage('won').value!, S.won)
money('the authorized rung equals the snapshot', stage('authorized').value!, S.authorized)
money('the invoiced rung equals the snapshot', stage('invoiced').value!, S.invoiced)
money('the collected rung is NET of refunds', stage('collected').value!, S.netCollected)
check('every rung says what it MEANS in words', R.funnel.stages.every(s => s.meaning.length > 20))

// ═════════════════════════════════════════════════════════════════════════════
H('9 · Stages, win rate, and the periods')
// ═════════════════════════════════════════════════════════════════════════════
eq('stage counts are history — nothing leaves the report',
  R.stageCounts, { new_lead: 0, contacted: 0, quote_draft: 2, quote_sent: 2, won: 3, lost: 1 })
eq('stage counts sum to the cohort', Object.values(R.stageCounts).reduce((a, b) => a + b, 0), quotes.length)
money('stage value sums to quoted + draft', Object.values(R.stageValue).reduce((a, b) => a + b, 0), S.quoted + S.draft)

eq('win rate is withheld at n=4 decided', S.winRate, null)
eq('undecided deals are counted, so the denominator is explainable', S.undecidedCount, 4)
const decided = Array.from({ length: 10 }, (_, n) =>
  Q({ id: `d-${n}`, status: n < 7 ? 'accepted' : 'declined', total: 100, customer_id: 'c-google' }))
const dRun = computeSalesAnalytics({ ...INPUT, quotes: decided })
check('at 10 decided a rate appears', dRun.snapshot.winRate !== null)
money('…and it is won/(won+lost) — unanswered quotes are outside it', dRun.snapshot.winRate!, 0.7)

const p30 = presetPeriod('30d', '2026-08-16')
eq('a 30-day period is inclusive at both ends', [p30.from, p30.to], ['2026-07-18', '2026-08-16'])
eq('a 90-day period', presetPeriod('90d', '2026-08-16').from, '2026-05-19')
eq('a 12-month period', presetPeriod('year', '2026-08-16').from, '2025-08-17')
eq('three presets, no more', PERIOD_PRESETS.map(p => p.key), ['30d', '90d', 'year'])
eq('a backwards custom range is a typo, not an empty screen',
  [customPeriod('2026-08-16', '2026-07-01').from, customPeriod('2026-08-16', '2026-07-01').to],
  ['2026-07-01', '2026-08-16'])

// An empty book is not an error — it is a book with no sales yet.
const empty = computeSalesAnalytics({
  ...INPUT, quotes: [], jobs: [], invoices: [], payments: [], changeOrders: [], customers: [],
})
check('an empty cohort produces zeros, not NaN',
  Object.values(empty.snapshot).every(v => v === null || (typeof v === 'number' && Number.isFinite(v))))
eq('…and withholds the win rate rather than reporting 0%', empty.snapshot.winRate, null)
eq('…and reports no unknown share rather than 0%', empty.sources.unknownPct, null)

// ═════════════════════════════════════════════════════════════════════════════
H('10 · No second engine — the imports are the contract')
// ═════════════════════════════════════════════════════════════════════════════
const mustImport: [string, string][] = [
  ['won/lost', "from '@/lib/salesStage'"],
  ['invoice totals', "from '@/lib/invoiceTotals'"],
  ['invoice balance', "from '@/lib/payments/ledger'"],
  ['cash rule', "from '@/lib/payments/analytics'"],
  ['authorized value', "from '@/lib/changeOrders'"],
  ['staleness', "from '@/lib/followup'"],
  ['source categories', "from '@/lib/attribution'"],
]
for (const [what, spec] of mustImport) {
  check(`${what} is IMPORTED, not redefined`, engineSrc.includes(spec), `missing ${spec}`)
}
check('no local won/lost predicate',
  !/(const|function)\s+is(Won|Lost)\b/.test(engineSrc))
check('no local cash predicate',
  !/kind\s*===\s*'payment'/.test(engineSrc) && !/provider\s*!==\s*'credit'/.test(engineSrc))
check('no local source mapping (a second attribution engine)',
  !/'facebook'\s*:|case\s+'google'/.test(engineSrc) && !engineSrc.includes('SOURCE_CATEGORIES'))
check('no stage column is written or read',
  !/pipeline_status|\.stage\b\s*=|'stage'/.test(engineSrc))
check('`billable` is not used where `authorized` is meant (extras are not authorized)',
  !engineSrc.includes('.billable'))

// ═════════════════════════════════════════════════════════════════════════════
H('11 · Tenancy — asserted per READ, not as a file-wide count')
// ═════════════════════════════════════════════════════════════════════════════
// ⚠️ A fixed-width lookahead BLEEDS into the next read, so a read that lost its
// filter borrows its neighbour's. The window is bounded to the next `.from(`.
// ⚠️ codeOnly again, and for a reason this file has been bitten by before: the
// loader's header comment QUOTES `.eq('user_id', uid)` while explaining the
// tenancy rule, so a strip-the-first-occurrence meta-mutation would delete the
// prose and leave every real read intact — a checker that always passes.
const loaderSrc = codeOnly(read('src/lib/sales/data.ts'))
const readBlocks: { table: string; body: string }[] = []
{
  const re = /\.from\('([a-z_]+)'\)/g
  const hits: { table: string; at: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(loaderSrc))) hits.push({ table: m[1], at: m.index })
  hits.forEach((h, idx) => {
    const end = idx + 1 < hits.length ? hits[idx + 1].at : loaderSrc.length
    readBlocks.push({ table: h.table, body: loaderSrc.slice(h.at, end) })
  })
}
check('the loader actually reads something', readBlocks.length >= 6, `found ${readBlocks.length}`)
for (const b of readBlocks) {
  check(`\`${b.table}\` is tenant-scoped in its OWN read`,
    b.body.includes(".eq('user_id', uid)"),
    `no user_id filter between this .from('${b.table}') and the next`)
}
// The meta-check: prove the checker above can actually fail. Strip the filter
// from the FIRST read only and confirm that read is caught.
{
  const firstIdx = loaderSrc.indexOf(".eq('user_id', uid)")
  const sabotaged = loaderSrc.slice(0, firstIdx) + loaderSrc.slice(firstIdx + ".eq('user_id', uid)".length)
  const re = /\.from\('([a-z_]+)'\)/g
  const hits: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sabotaged))) hits.push(m.index)
  const caught = hits.some((at, idx) => {
    const end = idx + 1 < hits.length ? hits[idx + 1] : sabotaged.length
    return !sabotaged.slice(at, end).includes(".eq('user_id', uid)")
  })
  check('the tenancy checker is not decoration — it catches a stripped filter', caught)
}
check('the loader pages every read (PostgREST truncates at 1000, silently)',
  !/\.select\(/.test(loaderSrc.replace(/pageAll[\s\S]*?\n\n/g, '')) || loaderSrc.includes('pageAll'))
check('id filters are CHUNKED (a huge in.() fails the whole request)',
  loaderSrc.includes('ID_CHUNK') && loaderSrc.includes('chunk('))
// ⚠️ EVERY read result must be error-guarded, asserted BY NAME. A regex looking
// for "some `if (x.error) return null` exists" stays green when one specific
// guard is removed, because its nine siblings still match — the same
// pass-by-accident shape as a file-wide tenancy count.
for (const res of [
  'qRes', 'jRes', 'invByQuote', 'invByJob', 'coRes',
  'custPeriodRes', 'payByInvoice', 'payByQuote', 'custRes',
]) {
  check(`\`${res}\` is error-guarded (a failed read is NULL, never a zeroed board)`,
    new RegExp(`${res}\\.error`).test(loaderSrc),
    `nothing tests ${res}.error — that read can fail silently and report $0`)
}

// ⚠️ Asserted INSIDE the quotes block, not file-wide. The customers read carries
// the same two date filters, so a file-wide `includes` stays green when the
// cohort scan itself loses its bound — which is the read that decides the whole
// report's contents.
const quoteBlock = readBlocks.find(b => b.table === 'quotes')
check('the cohort scan is bounded at BOTH ends, in its own read',
  !!quoteBlock &&
  quoteBlock.body.includes("gte('created_at', fromTs)") &&
  quoteBlock.body.includes("lt('created_at', toTsExclusive)"),
  quoteBlock ? quoteBlock.body.slice(0, 200) : 'no quotes read found')
check('the upper bound is the START OF THE NEXT DAY, so the last day is included',
  loaderSrc.includes('86_400_000') && loaderSrc.includes('toTsExclusive'),
  'lte(to) on a timestamptz drops everything quoted during the final day')

// ═════════════════════════════════════════════════════════════════════════════
H('12 · Tips are NOT integrated (the work has not landed)')
// ═════════════════════════════════════════════════════════════════════════════
// The brief: if Tips work is not landed, do not create speculative integration.
// `payments.kind` is 'payment' | 'credit' on main. A tip is a KIND in that lane's
// design, so anything here naming one would be predicting an unlanded schema.
for (const banned of ['tip', 'gratuity']) {
  check(`the engine names no "${banned}"`, !new RegExp(banned, 'i').test(engineSrc))
  check(`the loader names no "${banned}"`, !new RegExp(banned, 'i').test(loaderSrc))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`)
console.log(`  ${pass} passed · ${fail} failed`)
console.log('═'.repeat(60))
if (fail > 0) process.exit(1)
