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
// ⭐ OFFLINE BY CONSTRUCTION — grep this file for SUPABASE_URL / SERVICE_ROLE /
// ANON_KEY / VERIFY_FIXTURE and you will find nothing, which is what makes it
// RUN IN CI rather than skip there (the offline/live split that hid a schema
// drift for days — see the S106 landing notes). Sections 1–12 drive the real
// production modules by importing them, and read source text only where the rule
// is structural and has no runtime surface.
//
// ⭐⭐ SECTION 13 IS DIFFERENT AND IS THE MOST IMPORTANT PART. It builds this
// repository's schema from ZERO in a disposable in-process Postgres (PGlite) and
// calls the REAL `portal_accept_quote` / `quote_apply_choice` with no app code in
// the path. Everything above proves what the SOURCE says; only that proves what
// the DATABASE DOES — and the app is not the authority on acceptance, the
// database is. It SKIPS loudly if PGlite is absent.
//
// ⛔ IT TOUCHES NO REAL DATABASE. The only database it opens is created empty in
// memory and thrown away; there is no fixture to clean up and no tenant it could
// reach.

import { readFileSync } from 'node:fs'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { join } from 'node:path'

// The real engines. Imported, never re-described — a guard that restates the
// rule is a second copy of the rule.
import {
  quoteVisitAmount, jobVisitValue, quoteVisitAmountOrNull, jobVisitValueOrNull,
} from '../src/lib/visitValue'
import {
  isNoCharge, isPartialNoCharge, quotePriceState, jobPriceState,
  quoteAmountOrNull, jobAmountOrNull, passesMoneyDoor, moneyDoorBlock,
  amountText, excludedNote, sumQuoteAmounts, classifyLegacyZero, PRICE_STATE_LABEL, PRICE_STATE_MEANING,
  UNKNOWN_AMOUNT_TEXT, BLANK_NUMERIC_FIELD, MONEY_DOORS,
} from '../src/lib/pricingState'
import { optionSetProblem, optionProblemMessage, optionRowsFor } from '../src/lib/quoteOptions'
import { sendBlockedReason, canSendQuote, sendBlockedLabel } from '../src/lib/quoteStatus'
import { noChargeReasonProblem, NO_CHARGE_REASON_MAX } from '../src/lib/noChargeAction'

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

console.log('\n═══ 8b · One summer, and it hands back what it left out ═══')

const roll = sumQuoteAmounts([
  { total: 100 }, { total: 250 },
  { total: null },                       // unpriced — excluded
  { total: 0 },                          // a bare zero is ALSO unpriced
  { total: 0, ...FREE },                 // explicitly free — a real 0, counted
])
eq('only known amounts are summed', roll.total, 350)
eq('unpriced records are counted as excluded', roll.unknown, 2)
eq('free work IS counted (it is a known zero)', roll.counted, 3)
// ⚠️ `eq` is Object.is — it compares object IDENTITY, so comparing a rollup to an
// object literal would fail for a CORRECT result. Compare the fields.
const emptyRoll = sumQuoteAmounts([])
check('an empty set is a clean zero',
  emptyRoll.total === 0 && emptyRoll.unknown === 0 && emptyRoll.counted === 0,
  JSON.stringify(emptyRoll))
// ⭐ The divisor rule — the second half of the bug. An average must divide by
// what was summed, not by the size of the input.
check('counted is the honest divisor, not the input length',
  roll.counted !== 5 && roll.total / roll.counted > 100)

// ⛔ THE NINE COPIES. `reduce((s, q) => s + Number(q.total || 0), 0)` appeared in
// nine files, each silently adding a zero per unpriced quote. If one comes back,
// a figure starts lying again — so the EXPRESSION is banned outright.
{
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  // ⚠️ Grep the CODE, not the file. Half this repo's fix-comments quote the
  // expression they removed — including the ones this lane just wrote — so a raw
  // `git grep` reports its own documentation as a violation. Comments are
  // stripped first, then the remaining source is searched.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(p)) out.push(p)
    }
    return out
  }
  const offenders = walk(join(ROOT, 'src'))
    .filter(p => /\+\s*Number\([a-z]+\.total\s*\|\|\s*0\)/.test(stripComments(readFileSync(p, 'utf8'))))
    .map(p => p.slice(ROOT.length + 1))
  check('no file sums quote totals with a `|| 0` fallback any more', offenders.length === 0,
    offenders.join(' · '))
}

console.log('\n═══ 8c · Historical records are CLASSIFIED, never rewritten ═══')

const cls = (i: Parameters<typeof classifyLegacyZero>[0]) => classifyLegacyZero(i).klass
eq('a complete no-charge record is legitimate free', cls({ amount: 0, ...FREE }), 'legitimate_free')
eq('a completed $0 visit with no evidence is likely unpriced',
  cls({ amount: 0, completed: true }), 'likely_unpriced')
eq('a bare $0 with nothing around it is likely unpriced', cls({ amount: 0 }), 'likely_unpriced')
// ⭐ Everything that hints at intent WITHOUT recording it lands in ambiguous —
// the bucket that means "ask a human", not "assume".
eq('a half-written no-charge record is ambiguous',
  cls({ amount: 0, no_charge_at: FREE.no_charge_at }), 'ambiguous')
eq('a payment against a $0 record is ambiguous', cls({ amount: 0, hasPayment: true }), 'ambiguous')
eq('a $0 invoice is ambiguous, not free', cls({ amount: 0, hasInvoice: true }), 'ambiguous')
eq('an owner note reading "no charge" is ambiguous, not free',
  cls({ amount: 0, completed: true, note: 'No charge - warranty redo' }), 'ambiguous')
eq('an unrelated note does not make it ambiguous',
  cls({ amount: 0, completed: true, note: 'Gate code 4412' }), 'likely_unpriced')
// ⛔ The safety property: the classifier NEVER promotes a row to free on
// evidence weaker than a complete record. A false 'legitimate_free' closes a
// question that should have been asked.
check('nothing but a complete record is ever classified free',
  [{ amount: 0, hasInvoice: true }, { amount: 0, hasPayment: true },
   { amount: 0, note: 'comped' }, { amount: 0, no_charge_reason: 'goodwill' }]
    .every(i => cls(i) !== 'legitimate_free'))
check('every classification carries a reason a human can act on',
  [{ amount: 0 }, { amount: 0, ...FREE }, { amount: 0, hasInvoice: true }]
    .every(i => classifyLegacyZero(i).why.length > 25))

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
// ⚠️⚠️ EVERY site, not "at least one". This check originally used `.test()`, which
// is satisfied by a single surviving occurrence — and mutation testing found the
// hole: the rule appears at THREE save sites in this page, and breaking one left
// the guard green. Count both shapes instead, and require zero of the bad one.
{
  const good = (schedule.match(/Number\(values\.price\)\s*>\s*0\s*\?\s*Number\(values\.price\)\s*:\s*null/g) ?? []).length
  const bad = (schedule.match(/Number\(values\.price\)\s*>\s*0\s*\?\s*Number\(values\.price\)\s*:\s*0\b/g) ?? []).length
  check('every job save path writes NULL (never 0) for a blank price',
    good >= 3 && bad === 0, `${good} correct, ${bad} writing 0`)
}

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

// The invoice door already refused, and must keep refusing. ⚠️ This pinned the
// single-line form and went red when the refusal grew a second reason
// ('no-charge'). The RULE is "an amount that is not > 0 never drafts", which is
// what is asserted now — the shape of the statement was never the point.
const invoicing = stripComments(read('src/lib/invoicing.ts')).replace(/\s+/g, ' ')
check('the invoice drafter still refuses any amount that is not > 0',
  /if \(!\(amount > 0\)\) \{ return \{ created: false, reason:/.test(invoicing),
  'the $0 refusal changed shape — re-read it before assuming it still refuses')

console.log('\n═══ 10b · The No charge action, and what may write the decision ═══')

// The reason rule, driven from the real module the form calls.
check('an empty reason is refused with a sentence',
  (noChargeReasonProblem('') ?? '').length > 20)
check('a two-character reason is refused', !!noChargeReasonProblem('ok'))
eq('a real reason passes', noChargeReasonProblem('Warranty redo'), null)
check('an over-long reason is refused', !!noChargeReasonProblem('x'.repeat(NO_CHARGE_REASON_MAX + 1)))
eq('the max mirrors the database CHECK', NO_CHARGE_REASON_MAX, 500)

const action = stripComments(read('src/lib/noChargeAction.ts'))
// ⛔⛔ THE ONE-DOOR RULE. If the app can UPDATE these columns directly, every
// database-side guarantee above becomes optional — the actor could be forged,
// the three parts could be written apart, and nothing would reach audit_events.
check('the action module goes through the RPC, never a direct column write',
  /supabase\.rpc\(fn, args\)/.test(action) && !/from\('quotes'\)\s*\.update/.test(action))
check('it never names the columns in a write', !/no_charge_at\s*:/.test(action))
check('it has no actor parameter to forge',
  !/p_actor|actorId|no_charge_by\s*:/.test(action))
check('a missing migration is reported as such, not as a save failure',
  /needsMigration/.test(action) && /42883/.test(action) && /42703/.test(action))

// ⭐ The whole app is checked, not just the module: any OTHER writer would be a
// second door, and the point of the RPC is that there is only one.
{
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(p)) out.push(p)
    }
    return out
  }
  const writers = walk(join(ROOT, 'src'))
    .filter(p => {
      const src = stripComments(readFileSync(p, 'utf8'))
      // A no_charge column named on the left of a colon inside an object literal
      // is a WRITE shape. Reading them (destructuring, property access) is fine.
      return /no_charge_(at|reason|by)\s*:/.test(src)
    })
    .map(p => p.slice(ROOT.length + 1))
  check('NOTHING in src/ writes the no-charge columns directly', writers.length === 0,
    writers.join(' · '))
}

// The invoice door tells the two refusals apart.
const inv = stripComments(read('src/lib/invoicing.ts'))
check('the invoice result can say "deliberately free" as well as "no price"',
  /'no-charge'/.test(inv) && /isNoCharge\(job as NoChargeRecord\)/.test(inv))
check('… and still refuses to draft either as a $0 invoice',
  /if \(!\(amount > 0\)\) \{/.test(inv))
for (const [label, f] of [
  ['the schedule page', 'src/app/dashboard/schedule/page.tsx'],
  ['the dispatch board', 'src/app/dashboard/dispatch/page.tsx'],
] as const) {
  const src = stripComments(read(f)).replace(/\s+/g, ' ')
  check(`${label} says "No charge" rather than "no price" for free work`,
    /'no-charge'\) (setBanner|notify)\('Done — marked No charge/.test(src))
}

// Visibly no-charge, and never mistaken for unknown.
check('the quote header states the price state out loud',
  /PRICE_STATE_LABEL\[quotePriceState\(quote\)\]/.test(quoteDetail))
check('the send card offers the No charge route as well as a price',
  /setNoChargeOpen/.test(quoteDetail) && /Mark No charge/.test(quoteDetail))
check('the No charge form calls the one door',
  /markQuoteNoCharge\(supabase, quote\.id, noChargeReason\)/.test(quoteDetail))
check('it re-reads the row instead of guessing the timestamp it did not set',
  /from\('quotes'\)\.select\('\*'\)\.eq\('id', quote\.id\)\.single\(\)/.test(quoteDetail))

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

console.log('\n═══ 12 · The accept-door migration — in the apply path, awaiting re-version ═══')

// The DB fix is no longer a proposal: it is a MIGRATION CANDIDATE in
// supabase/migrations/, so verify:rebuild applies it from zero and section 13
// drives the resulting function. What this section pins is the paperwork around
// it — the parts a from-zero rebuild cannot see.
const migFiles = (require('node:fs') as typeof import('node:fs'))
  .readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
const noChargeFile = migFiles.find(f => /no_charge/.test(f))
check('the no-charge migration is IN the apply path', !!noChargeFile, migFiles.join(', '))

const migration = read(join('supabase', 'migrations', noChargeFile ?? 'missing.sql'))
check('it closes the accept hole',
  /if not v_free and \(v_base is null or v_base <= 0\) then/.test(migration))
// ⚠️ A `create or replace function` with a CHANGED signature creates an OVERLOAD
// and leaves the old body callable WITH ITS GRANTS — the S121 trap, where anon
// could still reach the un-hardened door. The argument list must stay identical.
check('it keeps quote_apply_choice\'s signature identical (no overload)',
  /quote_apply_choice\(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid\[\], p_via text\)/.test(migration))

// ⛔⛔ THE VERSION IS FAKE ON PURPOSE and S106 re-versions it at landing from the
// LIVE ledger. Two sessions have been bitten by choosing a version early (S76's
// was already in production as a different body), so the guard refuses to let a
// year-2999 placeholder quietly become permanent — and refuses to let anyone
// invent a real-looking one here either.
check('its version is the deliberate 2999 placeholder, not a real timestamp',
  /^29999999000000_/.test(noChargeFile ?? ''), noChargeFile)
check('its filename says a re-version is required',
  /temp_reversion_required/.test(noChargeFile ?? ''), noChargeFile)
check('the file itself tells S106 to re-version from the live ledger',
  /S106 RE-VERSIONS THIS AT LANDING, from the LIVE LEDGER AT APPLY TIME/.test(migration))
check('it warns that the app must not be deployed before it is applied',
  /APPLY THIS BEFORE deploying an app build that WRITES these columns/.test(migration))

// ⭐ The baseline is a snapshot of what PRODUCTION has run, and production has
// NOT run this yet — so the old body is still in there and that is correct. The
// apply path supersedes it. Asserted so that "the baseline has the hole" is a
// recorded fact rather than a surprise, and so the day production runs it and
// the baseline is recaptured, this check fails and tells the next session to
// re-measure instead of assuming.
check('the committed baseline still carries the OLD body (production has not run it)',
  !/if not v_free and/.test(baseline),
  'the baseline now has the fix — production applied it; recapture the contract and update this check')

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 13 · THE DB ACCEPTANCE DOOR — behaviour, from an empty Postgres ═══')

// ⭐⭐ THE SECTION THAT MATTERS MOST IN THIS FILE.
//
// Everything above proves what the SOURCE says. This proves what the DATABASE
// DOES — by building the schema from zero out of this repository and calling the
// real `quote_apply_choice` / `portal_accept_quote`, with no app code anywhere in
// the path. That distinction is the whole point: the app-side gates can all be
// correct and a quote can still be accepted through the portal, because the app
// is not the authority. The database is.
//
// ⚠️ SKIPS clean when PGlite is absent (the pattern verify:audit-trail uses), and
// says so loudly — a silent skip would let this become decoration.

async function dbDoor() {
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('  ⏭  SKIPPED — PGlite is not installed. This is THE behavioural proof:')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:unpriced-work')
    return
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })

  const apply = async (label: string, rawSql: string) => {
    const { sql } = substitutePlatformStatements(rawSql)
    const statements = splitStatements(sql)
    let n = 0
    try { for (const s of statements) { await db.exec(s + ';'); n++ } ; return true }
    catch (e) {
      fail(`applied ${label}`, `statement ${n + 1}/${statements.length}: ${String((e as Error).message).slice(0, 220)}\n      ` +
        (statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 200))
      return false
    }
  }

  if (!await apply('platform prelude', read(join('scripts', 'schema', 'platform-prelude.sql')))) return
  const migDir = join(ROOT, 'supabase', 'migrations')
  for (const f of (require('node:fs') as typeof import('node:fs')).readdirSync(migDir).filter(x => x.endsWith('.sql')).sort()) {
    if (!await apply(f, readFileSync(join(migDir, f), 'utf8'))) return
  }
  ok('the schema — baseline + the no-charge migration — applies from ZERO')

  const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[]
  const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0]

  // ⚠️⚠️ A HARNESS ACCOMMODATION, NOT A SCHEMA CHANGE — read before "fixing" it.
  // PGlite 0.5.5 is PostgreSQL 18.3; PRODUCTION IS 17. PG18 refuses every UPDATE
  // on a table that is in a publication with REPLICA IDENTITY FULL and carries
  // GENERATED columns — and `quotes` is all three (`total` and `subtotal` are
  // generated, and the baseline adds it to supabase_realtime with identity full
  // so an UPDATE payload can carry the old row). The error is a flat
  // "cannot update table quotes", which reads like a permissions bug and is not.
  //
  // S121 hit the same wall. Dropping the table from the publication in THIS
  // disposable database changes nothing about the schema under test: the
  // function body, the constraints and the grants are exactly what production
  // will run. What it removes is a realtime replication detail that only exists
  // to feed subscribers this test does not have.
  // ⛔ Never do this to a real database.
  await db.exec(`alter publication supabase_realtime drop table public."quotes"`)
  await db.exec(`alter publication supabase_realtime drop table public."customers"`)

  const OWNER = '00000000-0000-0000-0000-0000000c0001'
  const CUST  = '00000000-0000-0000-0000-0000000c0002'
  await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@s114.test')`)
  await db.exec(`insert into public.customers (id, user_id, name) values ('${CUST}', '${OWNER}', 'S114 Fixture')`)
  const TOKEN = 's114-portal-token'
  await db.exec(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ('${OWNER}', '${CUST}', '${TOKEN}')`)

  let seq = 0
  /** Create a quote in a named price state and hand back its id. */
  const mkQuote = async (opts: { price: number | null; free?: boolean; status?: string }) => {
    seq++
    // ⚠️ Hex only — a 'q' here is not a uuid, and Postgres says so at runtime
    // rather than at authoring time.
    const id = `00000000-0000-0000-0000-0000000d${String(seq).padStart(4, '0')}`
    await db.query(
      `insert into public.quotes (id, user_id, quote_number, customer_id, customer_name, address, service_type, initial_price, status,
         no_charge_at, no_charge_reason, no_charge_by)
       values ($1, $2, $3, $4, 'S114 Fixture', '1 Test Way', 'Service', $5, $6, $7, $8, $9)`,
      [id, OWNER, `S114-${seq}`, CUST, opts.price, opts.status ?? 'sent',
        opts.free ? new Date().toISOString() : null, opts.free ? 'Warranty redo' : null, opts.free ? OWNER : null])
    return id
  }
  const statusOf = async (id: string) => String((await one(`select status from public.quotes where id = $1`, [id]))?.status)
  const acceptedOf = async (id: string) => (await one(`select accepted_price from public.quotes where id = $1`, [id]))?.accepted_price
  /** The REAL customer-portal door — token in, boolean out. No app code. */
  const portalAccept = async (id: string, optionId: string | null = null) =>
    (await one(`select public.portal_accept_quote($1, $2, $3, null) as ok`, [TOKEN, id, optionId]))?.ok

  // ── A · a priced quote still works. Regression canary first. ───────────────
  const priced = await mkQuote({ price: 240 })
  eq('a PRICED quote is still accepted through the portal', await portalAccept(priced), true)
  eq('… and lands as accepted', await statusOf(priced), 'accepted')
  eq('… with a real accepted_price', Number(await acceptedOf(priced)), 240)

  // ── B · THE HOLE. Unpriced, from the customer's own portal door. ───────────
  const unpriced = await mkQuote({ price: null })
  eq('⛔ an UNPRICED quote is REFUSED by the database', await portalAccept(unpriced), false)
  eq('… and stays sent, not accepted', await statusOf(unpriced), 'sent')
  eq('… and never gets an accepted_price', await acceptedOf(unpriced), null)

  const zeroQuote = await mkQuote({ price: 0 })
  eq('⛔ a $0 quote with no no-charge record is REFUSED', await portalAccept(zeroQuote), false)
  eq('… and stays sent', await statusOf(zeroQuote), 'sent')

  // ── C · explicitly free work is accepted — the half that makes it usable ───
  const free = await mkQuote({ price: 0, free: true })
  eq('an explicitly NO-CHARGE quote IS accepted', await portalAccept(free), true)
  eq('… and lands as accepted', await statusOf(free), 'accepted')
  eq('… with a KNOWN accepted_price of 0 (not null)', Number(await acceptedOf(free)), 0)

  // ⛔ No charge is not Paid. The DB must not have invented a payment state.
  const freeRow = await one(`select status, accepted_price, no_charge_reason from public.quotes where id = $1`, [free])
  check('no-charge acceptance does NOT mark the quote paid',
    freeRow?.status === 'accepted', `status = ${freeRow?.status}`)
  check('the no-charge REASON survives acceptance',
    String(freeRow?.no_charge_reason ?? '') === 'Warranty redo', String(freeRow?.no_charge_reason))

  // ── D · options ───────────────────────────────────────────────────────────
  // A quote offering alternatives cannot be approved without naming one, and an
  // all-zero option set carries no price, so naming one must not authorise it.
  const withOpts = await mkQuote({ price: null })
  await db.query(`insert into public.quote_options (quote_id, user_id, name, price, sort_order)
                  values ($1,$2,'Basic',0,0), ($1,$2,'Full',0,1)`, [withOpts, OWNER])
  const zeroOpt = await one(`select id from public.quote_options where quote_id = $1 and name = 'Full'`, [withOpts])
  eq('⛔ naming an ALL-ZERO option does not authorise the quote',
    await portalAccept(withOpts, String(zeroOpt?.id)), false)
  eq('… and it stays sent', await statusOf(withOpts), 'sent')

  const mixed = await mkQuote({ price: null })
  await db.query(`insert into public.quote_options (quote_id, user_id, name, price, sort_order)
                  values ($1,$2,'Included',0,0), ($1,$2,'Full',500,1)`, [mixed, OWNER])
  const goodOpt = await one(`select id from public.quote_options where quote_id = $1 and name = 'Full'`, [mixed])
  eq('a PRICED option is accepted', await portalAccept(mixed, String(goodOpt?.id)), true)
  eq('… and snapshots that option\'s price', Number(await acceptedOf(mixed)), 500)

  // ── E · the all-three-or-none constraint is the DATABASE's, not the app's ──
  let refused = false
  try {
    await db.query(`insert into public.quotes (user_id, quote_number, customer_name, address, service_type, status, no_charge_at)
                    values ($1,'S114-partial','X','1 Test Way','Service','draft', now())`, [OWNER])
  } catch { refused = true }
  check('⛔ a HALF-WRITTEN no-charge record is refused by a CHECK constraint', refused,
    'a timestamp with no reason and no actor was accepted')

  let blankRefused = false
  try {
    await db.query(`insert into public.quotes (user_id, quote_number, customer_name, address, service_type, status,
                      no_charge_at, no_charge_reason, no_charge_by)
                    values ($1,'S114-blank','X','1 Test Way','Service','draft', now(), '   ', $1)`, [OWNER])
  } catch { blankRefused = true }
  check('⛔ a BLANK no-charge reason is refused by the database', blankRefused)

  // ── E2 · THE NO-CHARGE DOOR — the only thing allowed to write the decision ─
  // ⭐ `auth.uid()` reads request.jwt.claim.sub (the platform prelude models
  // PostgREST's JWT exactly as a real request presents it), so signing in is
  // setting that claim — the same thing the door will see in production.
  const asOwner = async () => {
    await db.exec(`set request.jwt.claim.sub = '${OWNER}'`)
    await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${OWNER}"}'`)
  }
  const asNobody = async () => {
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  }
  const setNoCharge = async (id: string, reason: string | null) =>
    (await one(`select public.quote_set_no_charge($1, $2) as ok`, [id, reason]))?.ok
  const ncOf = async (id: string) =>
    await one(`select no_charge_at, no_charge_reason, no_charge_by from public.quotes where id = $1`, [id])

  await asOwner()
  const draft = await mkQuote({ price: null, status: 'draft' })
  eq('the owner can mark a quote No charge', await setNoCharge(draft, 'Goodwill — storm damage'), true)
  const nc = await ncOf(draft)
  check('all three parts are written together',
    !!nc?.no_charge_at && String(nc?.no_charge_reason) === 'Goodwill — storm damage' && String(nc?.no_charge_by) === OWNER,
    JSON.stringify(nc))
  // ⛔ The actor is taken from the SESSION and cannot be passed in — the function
  // has no actor parameter at all, which is why it cannot be forged.
  eq('the actor is the signed-in owner, not a client-supplied value', String(nc?.no_charge_by), OWNER)

  const events = await rows(
    `select action from public.audit_events where entity_id = $1 order by seq`, [draft])
  check('the decision is written to the immutable audit trail',
    events.some(e => e.action === 'quote_marked_no_charge'),
    events.map(e => e.action).join(', '))

  eq('a BLANK reason does not mark it free', await setNoCharge(draft, '   '), true)
  eq('… because a blank reason CLEARS instead of setting', (await ncOf(draft))?.no_charge_at, null)

  // Clearing, and the safety rule on it.
  await setNoCharge(draft, 'Warranty')
  eq('the owner can CORRECT an accidental designation while it is a draft',
    await setNoCharge(draft, null), true)
  eq('… and the record is fully cleared', (await ncOf(draft))?.no_charge_reason, null)
  const cleared = await rows(`select action from public.audit_events where entity_id = $1`, [draft])
  check('clearing is audited too', cleared.some(e => e.action === 'quote_no_charge_cleared'))

  // ⛔⛔ THE BACK DOOR THAT MUST STAY SHUT. An ACCEPTED no-charge quote was
  // authorised BECAUSE it was explicitly free. Clearing that afterwards would
  // leave customer-authorised work with no price and no free-work record — the
  // exact state the accept gate exists to prevent, reached from behind.
  const acceptedFree = await mkQuote({ price: 0, free: true })
  await portalAccept(acceptedFree)
  eq('… the accepted free quote really is accepted', await statusOf(acceptedFree), 'accepted')
  await asOwner()
  eq('⛔ the No charge record CANNOT be cleared once the quote is accepted',
    await setNoCharge(acceptedFree, null), false)
  check('… and the evidence survives the attempt',
    !!(await ncOf(acceptedFree))?.no_charge_at)

  eq('a signed-out caller cannot mark anything free', await (async () => {
    await asNobody(); const r = await setNoCharge(draft, 'nope'); await asOwner(); return r
  })(), false)

  // ── F · a foreign tenant's token cannot approve anything ──────────────────
  // The tenancy statement was already there; re-asserted because this lane
  // changed the function body and a rewrite is exactly when one gets dropped.
  const OTHER = '00000000-0000-0000-0000-0000000c0009'
  await db.exec(`insert into auth.users (id, email) values ('${OTHER}', 'other@s114.test')`)
  const foreign = await mkQuote({ price: 300 })
  await db.query(`update public.quotes set user_id = $1, customer_id = null where id = $2`, [OTHER, foreign])
  eq('⛔ another tenant\'s quote is still refused', await portalAccept(foreign), false)

  await db.close?.()
}

// ⚠️ NOT top-level await — tsx transforms this file to CJS, where top-level await
// is a build error. Same shape verify-audit-trail uses for its PGlite half.
dbDoor()
  .catch(e => fail('the DB acceptance proof ran', String((e as Error).message).slice(0, 300)))
  .then(() => {
    console.log(failures === 0
      ? `\n✅ verify:unpriced-work — all checks passed\n`
      : `\n❌ verify:unpriced-work — ${failures} check(s) failed\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
