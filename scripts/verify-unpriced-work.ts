// ── Verify: unknown price never silently becomes $0 ─────────────────────────
//   npm run verify:unpriced-work
//
// THE DOMAIN LAW THIS GUARD EXISTS TO HOLD:
//
//     UNPRICED  ≠  INTENTIONALLY FREE  ≠  $0 DUE  ≠  PAID
//
// Four different facts. The app used to be able to say three of them, and it
// spelled the fourth — "nobody has priced this" — as the number 0. That zero
// then flowed into booked revenue, profitability, Growth recommendations, the
// pipeline and the invoice drafter, where it read as a real amount. A business
// with ten unpriced visits saw a confident $0 and no hint the figure was fiction.
//
// ⭐ OFFLINE AND PURE BY CONSTRUCTION — grep this file for SUPABASE_URL /
// SERVICE_ROLE / ANON_KEY / VERIFY_FIXTURE and you will find nothing, which is
// what makes it RUN IN CI rather than skip there (the offline/live split that
// hid a schema drift for days — see the S106 landing notes). It drives the real
// production modules by importing them, and reads source text only where the
// rule is structural and has no runtime surface.
//
// ⛔ IT WRITES NOTHING AND READS NO DATABASE. There is no fixture to clean up
// and no tenant it could touch.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The real engines. Imported, never re-described — a guard that restates the
// rule is a second copy of the rule.
import {
  quoteVisitAmount, jobVisitValue, quoteVisitAmountOrNull, jobVisitValueOrNull,
} from '../src/lib/visitValue'
import {
  isNoCharge, isPartialNoCharge, quotePriceState, jobPriceState,
  quoteAmountOrNull, jobAmountOrNull, passesMoneyDoor, moneyDoorBlock,
  amountText, excludedNote, PRICE_STATE_LABEL, PRICE_STATE_MEANING,
  UNKNOWN_AMOUNT_TEXT, BLANK_NUMERIC_FIELD, MONEY_DOORS,
} from '../src/lib/pricingState'
import { optionSetProblem, optionProblemMessage, optionRowsFor } from '../src/lib/quoteOptions'
import { sendBlockedReason, canSendQuote, sendBlockedLabel } from '../src/lib/quoteStatus'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, got: unknown, want: unknown) =>
  check(n, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ⚠️ `[^\n\r]*`, not `.*`: `.` does not match `\r`, so on a CRLF checkout a
// `.*`-based line-comment stripper leaves the carriage return behind and the
// NEXT line joins the comment — which has silently disarmed two guards in this
// repo already. Block comments are stripped first, and a `//` inside a string
// literal is left alone by only stripping comments that start a line or follow
// whitespace.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n\r]*/g, '$1')

console.log('\n═══ 1 · The four facts are four, not three ═══')

// The vocabulary itself. If a state is ever dropped, every sentence below it
// stops meaning what it says.
eq('three price states exist', Object.keys(PRICE_STATE_LABEL).sort().join(','),
  'no_charge,priced,unpriced')
check('every state has an owner-facing label', Object.values(PRICE_STATE_LABEL).every(v => v.trim().length > 1))
check('every state has a plain-words meaning', Object.values(PRICE_STATE_MEANING).every(v => v.trim().length > 10))
// ⛔ The single most important string in the lane: what the owner reads where a
// price would go. If this ever becomes "$0.00" the whole lane is undone.
check('the unknown label is not a currency amount',
  !/\$|^0$|^0\.00$/.test(UNKNOWN_AMOUNT_TEXT) && UNKNOWN_AMOUNT_TEXT.length > 2,
  `UNKNOWN_AMOUNT_TEXT = ${JSON.stringify(UNKNOWN_AMOUNT_TEXT)}`)
eq('unpriced does not read as free', PRICE_STATE_LABEL.unpriced !== PRICE_STATE_LABEL.no_charge, true)
// The blank form sentinel renders empty, and is NOT the number zero.
eq('the blank numeric field sentinel is an empty string', BLANK_NUMERIC_FIELD as unknown, '')
check('the blank sentinel is not 0', (BLANK_NUMERIC_FIELD as unknown) !== 0)

console.log('\n═══ 2 · visitValue preserves unknown — and its numeric reading is unchanged ═══')

// ⭐ CHARACTERIZATION. The numeric functions are now DEFINED as the OrNull pair
// spent on a zero. These cases pin that the refactor changed no existing answer:
// every expectation below was true before this lane and must stay true.
const q = (o: Record<string, unknown>) => o

eq('weekly cadence takes the weekly price', quoteVisitAmount(q({ weekly_price: 65 }), 'weekly'), 65)
eq('missing cadence falls back to any recurring price', quoteVisitAmount(q({ monthly_price: 200 }), 'weekly'), 200)
eq('one-off falls back to initial_price', quoteVisitAmount(q({ initial_price: 150 }), null), 150)
eq('initial_price of 0 falls through to total', quoteVisitAmount(q({ initial_price: 0, total: 90 }), null), 90)
eq('a job price wins over the quote', jobVisitValue(120, q({ initial_price: 80 }), null), 120)
eq('a null job price derives from the quote', jobVisitValue(null, q({ initial_price: 80 }), null), 80)

// ⛔ THE BUG, stated as a test. Before this lane both of these returned 0.
eq('no quote at all is UNKNOWN, not zero', quoteVisitAmountOrNull(null, null), null)
eq('a quote with no prices is UNKNOWN, not zero', quoteVisitAmountOrNull(q({}), null), null)
eq('an unpriced visit is UNKNOWN, not zero', jobVisitValueOrNull(null, null, null), null)
eq('an unpriced visit still reads 0 through the NUMERIC door', jobVisitValue(null, null, null), 0)
// The two readings must agree wherever the answer IS known — one arithmetic.
eq('known values agree across both readings',
  jobVisitValue(null, q({ weekly_price: 65 }), 'weekly') === jobVisitValueOrNull(null, q({ weekly_price: 65 }), 'weekly'), true)

// ⚠️ The `||` semantics inside quoteVisitAmountOrNull are load-bearing and were
// preserved deliberately: a NEGATIVE price is returned, not skipped. Rewriting
// those truthiness tests as `> 0` would silently change this answer, which is a
// DIFFERENT bug from the one this lane fixes.
eq('a negative initial_price is returned, not treated as unknown',
  quoteVisitAmountOrNull(q({ initial_price: -5 }), null), -5)

console.log('\n═══ 3 · A bare $0 is unpriced; only a complete record is free ═══')

eq('an absent quote is unpriced', quotePriceState(null), 'unpriced')
eq('a quote with no total is unpriced', quotePriceState({ total: null }), 'unpriced')
// ⛔⛔ THE CENTRAL ASSERTION OF THIS LANE.
eq('a bare $0 total is UNPRICED, never free', quotePriceState({ total: 0 }), 'unpriced')
eq('a real total is priced', quotePriceState({ total: 240 }), 'priced')

const FREE = { no_charge_at: '2026-08-28T10:00:00Z', no_charge_reason: 'Warranty callback', no_charge_by: 'u-1' }
eq('a complete no-charge record is free', quotePriceState({ total: 0, ...FREE }), 'no_charge')
eq('free work resolves to a KNOWN zero', quoteAmountOrNull({ total: 0, ...FREE }), 0)
eq('unpriced work resolves to UNKNOWN', quoteAmountOrNull({ total: 0 }), null)

// Partial evidence is not a decision. Each of the three parts alone must fail.
eq('a timestamp alone is not free', isNoCharge({ no_charge_at: FREE.no_charge_at }), false)
eq('a reason alone is not free', isNoCharge({ no_charge_reason: 'because' }), false)
eq('an actor alone is not free', isNoCharge({ no_charge_by: 'u-1' }), false)
eq('a blank reason is not a reason', isNoCharge({ ...FREE, no_charge_reason: '   ' }), false)
eq('all three together are free', isNoCharge(FREE), true)
eq('partial evidence is reported as partial', isPartialNoCharge({ no_charge_at: FREE.no_charge_at }), true)
eq('a complete record is not partial', isPartialNoCharge(FREE), false)
eq('an empty record is not partial', isPartialNoCharge({}), false)

console.log('\n═══ 4 · A visit: null price means "follow the quote", not "free" ═══')

// ⭐ The distinction that makes the job side subtle. `jobs.price = null` is the
// NORMAL state of every visit in a quote-linked series — lib/recurrence and the
// schedule page write it deliberately. It has never meant free and must not
// start to.
eq('a null job price WITH a quote is priced', jobPriceState({ price: null }, q({ initial_price: 90 }), null), 'priced')
eq('a null job price with NO quote is unpriced', jobPriceState({ price: null }, null, null), 'unpriced')
eq('a $0 job price with no quote is unpriced', jobPriceState({ price: 0 }, null, null), 'unpriced')
eq('an explicitly free visit is free', jobPriceState({ price: 0, ...FREE }, null, null), 'no_charge')
eq('a free visit is a KNOWN zero', jobAmountOrNull({ price: 0, ...FREE }, null, null), 0)
eq('an unpriced visit is UNKNOWN', jobAmountOrNull({ price: null }, null, null), null)
eq('a priced visit reports its amount', jobAmountOrNull({ price: 75 }, null, null), 75)

console.log('\n═══ 5 · The money doors refuse unpriced work, and admit free work ═══')

eq('seven money doors are named', MONEY_DOORS.length, 7)
for (const door of MONEY_DOORS) {
  check(`${door}: unpriced is refused with a sentence`,
    typeof moneyDoorBlock('unpriced', door) === 'string' && (moneyDoorBlock('unpriced', door) as string).length > 15)
  eq(`${door}: priced passes`, moneyDoorBlock('priced', door), null)
  // ⭐ THE HALF THAT MAKES FREE WORK POSSIBLE. Before this lane every door
  // refused a $0, so genuinely free work could not be sent at all and the
  // owner's only way out was to invent a number.
  eq(`${door}: explicitly free passes`, moneyDoorBlock('no_charge', door), null)
}
eq('unpriced fails the door predicate', passesMoneyDoor('unpriced'), false)
eq('priced passes the door predicate', passesMoneyDoor('priced'), true)
eq('no_charge passes the door predicate', passesMoneyDoor('no_charge'), true)
// The refusal must tell the owner about BOTH ways out, or it reads as "you must
// invent a price" — which is how the manufactured zeros got typed in.
check('the send refusal offers the No charge route',
  /no charge/i.test(moneyDoorBlock('unpriced', 'send') as string),
  moneyDoorBlock('unpriced', 'send') as string)

console.log('\n═══ 6 · The send gate ═══')

eq('no customer blocks first', sendBlockedReason({ customer_id: null, total: 500 }), 'no_customer')
eq('an unpriced quote cannot be sent', sendBlockedReason({ customer_id: 'c1', total: null }), 'no_price')
eq('a $0 quote cannot be sent', sendBlockedReason({ customer_id: 'c1', total: 0 }), 'no_price')
eq('a priced quote can be sent', sendBlockedReason({ customer_id: 'c1', total: 500 }), null)
eq('canSendQuote agrees with the reason', canSendQuote({ customer_id: 'c1', total: 500 }), true)
// ⛔ THE REGRESSION THIS LANE FIXES ON THE SEND DOOR: real free work is sendable.
eq('an explicitly free quote CAN be sent',
  sendBlockedReason({ customer_id: 'c1', total: 0, ...FREE }), null)
check('the send label names both ways out', /no charge/i.test(sendBlockedLabel('no_price')))

console.log('\n═══ 7 · Quote options ═══')

const opt = (name: string, price: number) => ({ name, price, is_recommended: false })
eq('a normal set is fine', optionSetProblem([opt('Basic', 100), opt('Full', 200)]), null)
// One zero alongside a priced tier is a real "included" option.
eq('one included tier is allowed', optionSetProblem([opt('Basic', 0), opt('Full', 200)]), null)
// ⛔⛔ ALL-ZERO OPTIONS — the hole the audit found. The customer saw
// "$0.00 / $0.00 / $0.00" and could accept one.
eq('an ALL-zero option set is refused',
  optionSetProblem([opt('Basic', 0), opt('Full', 0)]), 'all_unpriced')
eq('a three-way all-zero set is refused',
  optionSetProblem([opt('A', 0), opt('B', 0), opt('C', 0)]), 'all_unpriced')
check('the all-unpriced refusal has a sentence',
  optionProblemMessage('all_unpriced').length > 30 && /price|charge/i.test(optionProblemMessage('all_unpriced')))
eq('a negative option price is still refused',
  optionSetProblem([opt('Basic', -1), opt('Full', 200)]), 'no_price')
eq('a non-numeric option price is still refused',
  optionSetProblem([{ name: 'Basic', price: NaN, is_recommended: false }, opt('Full', 200)]), 'no_price')

// ⛔ `Number(o.price) || 0` used to live here — a blank input became a real
// $0.00 offer on the row. There is no coercion left: the builder must run
// optionSetProblem first, and a non-numeric price is now a loud failure.
let threw = false
try { optionRowsFor([{ name: 'X', price: NaN, is_recommended: false }], 'q1', 'u1') } catch { threw = true }
check('optionRowsFor REFUSES a non-numeric price instead of writing 0', threw)
const rows = optionRowsFor([opt('Basic', 0), opt('Full', 200)], 'q1', 'u1')
eq('a deliberate zero tier still saves as 0', rows[0].price, 0)
eq('a priced tier saves its price', rows[1].price, 200)

console.log('\n═══ 8 · Totals may exclude unknowns — they may not pretend they were zero ═══')

const money = (n: number) => `$${n.toFixed(2)}`
eq('a known amount renders as money', amountText(240, money), '$240.00')
eq('a known ZERO renders as money, not as unknown', amountText(0, money), '$0.00')
eq('an unknown renders as the unknown label', amountText(null, money), UNKNOWN_AMOUNT_TEXT)
eq('a clean total carries no apology', excludedNote(0), null)
check('one excluded record is named', /1 record/.test(excludedNote(1) as string))
check('several excluded records are named', /3 visits/.test(excludedNote(3, 'visit') as string))
check('the note says they were EXCLUDED, not counted',
  /exclud/i.test(excludedNote(2) as string), excludedNote(2) as string)

console.log('\n═══ 9 · Structural — the fallbacks cannot come back ═══')

// ⚠️ Asserting a constant is IMPORTED is not asserting it is USED. Each check
// below tests the EXPRESSION, not the import line.

const builder = stripComments(read('src/components/quotes/QuoteBuilder.tsx'))
// ⛔⛔ The fallback the brief named by hand.
check('QuoteBuilder no longer spends a missing cadence price on 0',
  !/\?\.price\s*\?\?\s*0/.test(builder),
  'a `?.price ?? 0` is back in QuoteBuilder')
check('QuoteBuilder fills a missing cadence with BLANK',
  /suggested\.weekly\s*\?\?\s*BLANK/.test(builder) && /suggested\.biweekly\s*\?\?\s*BLANK/.test(builder),
  'applySuggested no longer uses the BLANK sentinel')
check('the measure payload fills BLANK, not 0',
  /sel\.oneTime\s*\?\?\s*BLANK/.test(builder) && /sel\.weekly\s*\?\?\s*BLANK/.test(builder))
// The tile must REFUSE the tap, not merely look different.
check('an unpriceable cadence tile is disabled', /disabled=\{unpriced\}/.test(builder))
check('an unpriceable cadence tile shows the unknown label',
  /\{UNKNOWN_AMOUNT_TEXT\}/.test(builder))
// The copy that described the bug as the design.
check('the builder no longer promises to create a $0 quote',
  !/creates a \$0 quote/.test(builder))
// ⚠️ JSX copy wraps, so the sentence carries a newline and indentation in the
// middle of itself. Normalise whitespace before matching — a guard that only
// passes while the copy happens to fit on one line is a guard that fails the
// next time somebody reflows a paragraph.
const builderFlat = builder.replace(/\s+/g, ' ')
check('the builder says an unpriced draft cannot be sent, approved or invoiced',
  /unpriced draft/.test(builderFlat) && /can[’'`]t be sent, approved or invoiced/.test(builderFlat))

const jobForm = stripComments(read('src/components/schedule/JobForm.tsx'))
// ⛔ "Add Job defaults to $0" — the brief's own words.
check('Add Job does not seed the price field with 0',
  !/\bprice:\s*0\b/.test(jobForm), 'JobForm still seeds `price: 0`')
check('Add Job seeds the price field BLANK', /\bprice:\s*BLANK\b/.test(jobForm))
check('the price hint says leave it BLANK, not leave it 0',
  !/[Ll]eave 0/.test(jobForm) && /[Ll]eave blank/.test(jobForm))
check('the price field shows the unknown label as its placeholder',
  /placeholder=\{UNKNOWN_AMOUNT_TEXT\}/.test(jobForm))

const schedule = stripComments(read('src/app/dashboard/schedule/page.tsx'))
check('editing a visit does not render a NULL price as 0',
  !/price:\s*editing\.price\s*\?\?\s*0/.test(schedule),
  'the job editor seeds a null price as 0 again')
check('editing a visit seeds a NULL price BLANK',
  /price:\s*editing\.price\s*\?\?\s*BLANK_NUMERIC_FIELD/.test(schedule))
// The save path is what makes BLANK safe — it must keep turning blank into NULL.
check('the save path still writes NULL for a blank price',
  /Number\(values\.price\)\s*>\s*0\s*\?\s*Number\(values\.price\)\s*:\s*null/.test(schedule))

// ⭐ ONE sentinel, not two. A second local copy is how the fix drifted out of
// QuoteBuilder once already (the 2026-07-26 replay).
const pricingState = read('src/lib/pricingState.ts')
check('the blank sentinel is defined exactly once, in lib/pricingState',
  /export const BLANK_NUMERIC_FIELD/.test(pricingState))
for (const [label, src] of [['QuoteBuilder', builder], ['JobForm', jobForm]] as const) {
  check(`${label} imports the shared sentinel rather than redeclaring it`,
    !/const BLANK = ''\s*as unknown as number/.test(src),
    `${label} declares its own BLANK again`)
}

console.log('\n═══ 10 · The gates are wired at the doors, not just defined ═══')

const quoteDetail = stripComments(read('src/app/dashboard/quotes/[id]/page.tsx'))
check('the quote page refuses to mark an unpriced quote won',
  /moneyDoorBlock\(quotePriceState\(quote\), 'won'\)/.test(quoteDetail))
check('and it returns rather than continuing', /if \(wonBlock\) \{ toast\.error\(wonBlock\); return \}/.test(quoteDetail))

const statusControl = stripComments(read('src/components/quotes/QuoteStatusControl.tsx'))
check('the status picker gates accepted/completed/paid',
  /s === 'accepted' \|\| s === 'completed' \|\| s === 'paid'/.test(statusControl))
check('the status picker asks the same engine',
  /moneyDoorBlock\(quotePriceState\(/.test(statusControl))

// The invoice door already refused, and must keep refusing.
const invoicing = stripComments(read('src/lib/invoicing.ts'))
check('the invoice drafter still refuses a $0 amount',
  /if \(!\(amount > 0\)\) return \{ created: false, reason: 'no-amount' \}/.test(invoicing))

console.log('\n═══ 11 · The public booking path ═══')

// ⭐ BookingClient keeps a `?? 0`, and it is SAFE — but only because
// submit_booking nullifs each zero back out before it reaches the quote. That
// dependency is invisible from the TypeScript, so it is asserted here.
const baseline = (() => {
  const dir = join(ROOT, 'supabase', 'migrations')
  const f = require('node:fs').readdirSync(dir).find((x: string) => x.endsWith('_baseline.sql'))
  return readFileSync(join(dir, f), 'utf8')
})()
check('submit_booking still nullifs a $0 cadence price out of the quote',
  /nullif\(p_initial, 0\), nullif\(p_weekly, 0\), nullif\(p_biweekly, 0\), nullif\(p_monthly, 0\)/.test(baseline),
  'BookingClient\'s `?? 0` is only safe because of this nullif — restore it or fix BookingClient')

const booking = read('src/app/book/[token]/BookingClient.tsx')
check('the booking client records why its `?? 0` is safe',
  /THE LOAD-BEARING HALF IS THE `nullif` IN THE RPC/.test(booking))

console.log('\n═══ 12 · The accept door — proposal, and what is NOT yet true ═══')

// ⚠️ HONEST GAP, ASSERTED AS A GAP. The DB-level fix for `quote_apply_choice`
// (an unpriced quote can currently be ACCEPTED with a NULL accepted_price) is
// written but NOT APPLIED — it lives in supabase/proposals/, deliberately
// outside the apply path. This section pins the proposal's existence and its
// content so it cannot be quietly lost, and pins that the live baseline still
// has the hole, so the day it IS applied this check fails loudly and tells the
// next session to re-measure rather than assume.
const proposal = read('supabase/proposals/no_charge_v1.sql')
check('the no-charge proposal exists and is marked unapplied',
  /THIS FILE IS NOT IN THE APPLY PATH AND HAS NOT BEEN APPLIED/.test(proposal))
check('the proposal closes the accept hole',
  /if not v_free and \(v_base is null or v_base <= 0\) then/.test(proposal))
check('the proposal keeps quote_apply_choice\'s signature identical (no overload)',
  /quote_apply_choice\(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid\[\], p_via text\)/.test(proposal))
check('the proposal is NOT in the apply path',
  !require('node:fs').readdirSync(join(ROOT, 'supabase', 'migrations')).some((f: string) => /no_charge/.test(f)))
check('the live baseline still carries the accept hole (proposal not yet applied)',
  !/if not v_free and/.test(baseline),
  'the proposal appears to be APPLIED — re-measure section 12 and update this guard')

console.log(failures === 0
  ? `\n✅ verify:unpriced-work — all checks passed\n`
  : `\n❌ verify:unpriced-work — ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
