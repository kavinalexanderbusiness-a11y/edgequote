// ── Verify: payment-timing copy — one interpretation, no surface contradicts it ─
//   npm run verify:payment-timing-copy
//
// WHY THIS SCRIPT EXISTS
// A production audit found EdgeHQ telling one customer two different things
// about their own money, twenty seconds apart: the portal's quote card promised
// "Nothing is charged when you approve — you'll get an invoice once the work is
// done" on EVERY quote, and the approval flow then asked a deposit-gated
// customer for half the job up front.
//
// The numbers were never wrong. lib/payments/depositGate has always been the one
// arithmetic for the scheduling deposit and was correct throughout. The WORDS
// were unowned — six surfaces each composed their own sentence, and two of them
// had never heard of the deposit rule. A shared engine for the figures does not
// protect you if every surface writes its own sentence about them.
//
// So this guard asserts a copy contract, not a maths one:
//
//   1. There is ONE interpretation — lib/payments/paymentTiming — and it admits
//      exactly the two modes the schema can express. No speculative future mode.
//   2. For any given configuration, EVERY sentence the product produces agrees
//      with it. A gated quote is never promised money-after-work; an ungated one
//      is never threatened with a deposit.
//   3. No surface composes its own payment-timing sentence. Structural pins on
//      each of the six former sources.
//   4. The templates and adjacent engines (deposit request, invoice, scheduling
//      gate) do not reintroduce a contradicting claim.
//
// §2 is MUTATION-TESTED against the real historical strings: the contradiction
// detector is run over the exact copy that shipped the defect, and must flag
// every one. A detector that cannot fail proves nothing.
//
// Pure: no network, no DB, no fixtures, no writes anywhere.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  paymentTiming, quoteTimingLine, approvalTimingLine, approvedTimingLine,
  depositCreditLine, pdfTimingLine,
  type PaymentTiming,
} from '../src/lib/payments/paymentTiming'
import { requiredDeposit, type GateQuote } from '../src/lib/payments/depositGate'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Strip comments BEFORE any absence assertion — this guard's whole subject is
// prose, and the comments explaining the fix quote the very strings the fix
// removed. Without stripping, every "must no longer say X" check would be
// satisfied by the comment saying "we used to say X". CRLF-safe: `.` does not
// match \r, so a CRLF checkout otherwise disarms every `.*$` stripper.
//
// ⚠️ LINE comments are stripped BEFORE block comments, which is the opposite of
// the order most guards in this repo use — and the difference is load-bearing
// here. PortalClient.tsx line 37 contains, inside a `//` comment, the path
// fragment `./components/*.` — a `/*` the block-comment regex reads as an OPEN.
// It then pairs with the first REAL `*/`, every subsequent pair shifts by one,
// and the cascade ate 83% of the file (59,397 chars → 10,564). Every absence
// assertion in §3 would have passed against wreckage. Removing line comments
// first removes the false open with them.
//
// Same CRLF rule as everywhere: normalize \r\n first, because `.` does not match
// \r and a CRLF checkout otherwise disarms every `.*$` stripper.
const stripComments = (s: string) => s.replace(/\r\n/g, '\n')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"])\/\/[^\n]*/g, '$1')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

// ── Fixtures: one quote, three configurations ────────────────────────────────
// The brief's worked example. $2,700 job; the rule is what changes.
const NONE: GateQuote = { status: 'sent', total: 2700, accepted_price: null, deposit_type: null, deposit_value: null }
const PCT: GateQuote = { ...NONE, deposit_type: 'percent', deposit_value: 50 }
const FIXED: GateQuote = { ...NONE, deposit_type: 'fixed', deposit_value: 500 }
// Approved: accepted_price is the consent snapshot the RPC wrote.
const PCT_ACCEPTED: GateQuote = { ...PCT, status: 'accepted', accepted_price: 2700 }

console.log('\n■ 1. ONE interpretation, and only the modes the schema can express')
{
  check('no deposit rule → invoice_after_work', paymentTiming(NONE).mode === 'invoice_after_work')
  check('percent rule → deposit_before_scheduling', paymentTiming(PCT).mode === 'deposit_before_scheduling')
  check('fixed rule → deposit_before_scheduling', paymentTiming(FIXED).mode === 'deposit_before_scheduling')
  check('percent deposit is depositGate\'s figure, never a second maths',
    paymentTiming(PCT).depositAmount === requiredDeposit(PCT) && paymentTiming(PCT).depositAmount === 1350,
    `got ${paymentTiming(PCT).depositAmount}, gate says ${requiredDeposit(PCT)}`)
  check('fixed deposit is depositGate\'s figure', paymentTiming(FIXED).depositAmount === requiredDeposit(FIXED))

  const src = read('src/lib/payments/paymentTiming.ts')
  const code = stripComments(src)
  // The union must hold exactly two members. A third mode string means someone
  // started the future engine inside a copy module.
  const union = /export type PaymentTimingMode\s*=\s*([^\n]+)/.exec(code)?.[1] ?? ''
  check('PaymentTimingMode declares exactly the two supported modes',
    /'invoice_after_work'/.test(union) && /'deposit_before_scheduling'/.test(union)
    && (union.match(/'/g) || []).length === 4, `union was: ${union.trim()}`)

  // ⛔ The future engine is DOCUMENTED, never implemented. Any of these tokens in
  // the engine means a mode the database cannot carry.
  for (const t of ['full_upfront', 'fullUpfront', 'before_appointment', 'beforeAppointment',
    'milestone', 'installment', 'instalment', 'net_terms', 'netTerms', 'net30', 'recurring_billing']) {
    check(`engine implements no future mode: ${t}`, !new RegExp(t, 'i').test(code))
  }
  check('the future modes ARE documented', (() => {
    const doc = read('docs/PAYMENT-TIMING.md')
    return /Full upfront/i.test(doc) && /Before appointment/i.test(doc) && /Net 7/i.test(doc)
      && /Milestones/i.test(doc) && /Installments/i.test(doc) && /Recurring billing/i.test(doc)
  })())
  check('the engine holds no arithmetic of its own (figures come from depositGate)',
    /from '@\/lib\/payments\/depositGate'/.test(code)
    && !/\*\s*0?\.\d|\/\s*100\b|Math\.round\(/.test(code),
    'a percent calculation here would be a second deposit engine')
}

console.log('\n■ 2. THE contradiction detector — and proof it can fail')
{
  // A sentence contradicts the configuration when it promises the customer that
  // nothing is due before the work, on a quote that requires money before
  // scheduling. Deliberately narrow: the CORRECT gated sentence also contains
  // "invoiced once the work is done" (about the REMAINDER), and that is not a
  // contradiction — it is the second half of the truth. What makes a claim false
  // is promising nothing-before-work while saying nothing about the deposit.
  const NOTHING_BEFORE_WORK = /nothing is charged when you approve|only get an invoice after the work|nothing is due yet|no (payment|deposit) is (due|required)/i
  const MENTIONS_DEPOSIT = /deposit/i
  const promisesNothingBeforeWork = (s: string) => NOTHING_BEFORE_WORK.test(s) && !MENTIONS_DEPOSIT.test(s)
  const asksForDeposit = (s: string) => MENTIONS_DEPOSIT.test(s)

  // ⭐ MUTATION TEST — the exact strings that shipped the defect. Each is fed to
  // the detector against a GATED configuration; every one must be flagged. If
  // this block ever goes quiet, the detector has stopped detecting and every
  // check below it is worthless.
  const SHIPPED_DEFECTS: [string, string][] = [
    ['portal quote card (model.ts explain)',
      'Nothing is charged when you approve — you’ll get an invoice once the work is done.'],
    ['portal Home approve caption (HomeTab.tsx)',
      'Nothing is charged when you approve.'],
    ['approval dialog, ungated branch (PortalClient.tsx)',
      'Approving doesn’t charge you — we’ll confirm a date with you first, and you’ll only get an invoice after the work is done.'],
  ]
  for (const [where, bad] of SHIPPED_DEFECTS) {
    check(`MUTATION — the shipped copy is caught: ${where}`, promisesNothingBeforeWork(bad),
      `detector failed to flag: "${bad}"`)
  }
  // …and the inverse mutation: a deposit sentence on a quote that has no rule.
  check('MUTATION — a deposit ask on an ungated quote is caught',
    asksForDeposit('A $1,350.00 deposit is required before we schedule your visit.'))
  // Proof the detector is not simply always-true: the CORRECT gated sentence,
  // which does mention the work being invoiced, must NOT be flagged.
  check('…and the correct gated sentence is NOT flagged (no false positive)',
    !promisesNothingBeforeWork(quoteTimingLine(paymentTiming(PCT))),
    `flagged: "${quoteTimingLine(paymentTiming(PCT))}"`)

  // ── The live matrix: every sentence the product produces, per configuration ──
  // THE rule from the brief: "If 50% is required before scheduling, every
  // surface must say that. If nothing is due until completion, approval must not
  // suddenly request a deposit."
  const gate = { outstanding: 1350, status: 'awaiting' as const }
  const satisfied = { outstanding: 0, status: 'satisfied' as const }
  const sentencesFor = (t: PaymentTiming): [string, string][] => [
    ['quote card / PDF', quoteTimingLine(t)],
    ['approval dialog', approvalTimingLine(t)],
    ['pdf', pdfTimingLine(t)],
  ]

  for (const [label, q] of [['percent', PCT_ACCEPTED], ['fixed', FIXED]] as [string, GateQuote][]) {
    const t = paymentTiming(q)
    for (const [where, s] of sentencesFor(t)) {
      check(`GATED (${label}) — ${where} never promises money-after-work`,
        !promisesNothingBeforeWork(s), `said: "${s}"`)
      check(`GATED (${label}) — ${where} names the deposit`, asksForDeposit(s), `said: "${s}"`)
    }
    check(`GATED (${label}) — approved-state line names the deposit`,
      asksForDeposit(approvedTimingLine(t, gate)))
    check(`GATED (${label}) — every surface agrees a deposit comes first`,
      sentencesFor(t).every(([, s]) => /before we schedule|to secure your booking|secures your booking/i.test(s)))
  }

  const tNone = paymentTiming(NONE)
  for (const [where, s] of sentencesFor(tNone)) {
    check(`UNGATED — ${where} never mentions a deposit`, !asksForDeposit(s), `said: "${s}"`)
  }
  check('UNGATED — the approved-state line never mentions a deposit',
    !asksForDeposit(approvedTimingLine(tNone, { outstanding: 0, status: 'none' })))

  // The FIGURE in the words is the gate's figure. A sentence naming $1,340 while
  // Stripe asks $1,350 is the same class of defect one layer down.
  check('the gated sentence names the gate\'s own figure',
    quoteTimingLine(paymentTiming(PCT_ACCEPTED)).includes('1,350'),
    quoteTimingLine(paymentTiming(PCT_ACCEPTED)))

  // ── basisSettled: an unchosen options quote has no settled price ────────────
  // Printing the leading option's deposit to someone about to pick a different
  // option is a wrong number on paper they keep.
  const unsettled = paymentTiming(PCT, { basisSettled: false })
  check('unchosen options quote (percent) states the % and NO dollar figure',
    unsettled.depositAmount === null && !/\$/.test(quoteTimingLine(unsettled)),
    quoteTimingLine(unsettled))
  check('…but still tells them a deposit is coming', asksForDeposit(quoteTimingLine(unsettled)))
  check('a FIXED rule needs no basis — $500 is $500 whichever option they pick',
    paymentTiming(FIXED, { basisSettled: false }).depositAmount === 500)

  // ── The ledger, not the rule, decides what the approved customer is told ────
  check('satisfied → says the deposit comes off the final invoice',
    /comes off your final invoice/i.test(approvedTimingLine(paymentTiming(PCT_ACCEPTED), satisfied)))
  check('satisfied line is depositCreditLine (one sentence, one home)',
    approvedTimingLine(paymentTiming(PCT_ACCEPTED), satisfied) === depositCreditLine())
  // ⚠️ …and it must not OVERCLAIM. Applying the credit to an invoice is a manual
  // owner action (applyCreditToInvoice, from the "Apply $X credit" button) and
  // nothing does it automatically — so "comes off your final invoice" states the
  // contract, while "already deducted" would assert a ledger movement that has
  // not happened. See docs/PAYMENT-TIMING.md § "The one claim this repair makes
  // that the system does not guarantee". This guard exists so a future tidy-up
  // cannot quietly upgrade the promise.
  check('…and never claims the deduction has ALREADY happened',
    !/already (deducted|applied|credited|taken off)|has been (deducted|reduced|applied)|balance (has|is) (already )?(been )?reduced/i
      .test(depositCreditLine()),
    `overclaims: "${depositCreditLine()}"`)
  check('partial never reads as satisfied',
    !/comes off your final invoice/i.test(
      approvedTimingLine(paymentTiming(PCT_ACCEPTED), { outstanding: 350, status: 'partial' })))
  // The OVERRIDE case: the owner booked anyway and the money is still owed.
  // "Secures your booking" would describe a gate that was waived.
  const overridden = approvedTimingLine(paymentTiming(PCT_ACCEPTED), gate, true)
  check('overridden+scheduled — says booked AND still outstanding',
    /booked/i.test(overridden) && /outstanding/i.test(overridden), overridden)
  check('…and does not claim the deposit still secures the booking',
    !/secures your booking/i.test(overridden), overridden)
}

console.log('\n■ 3. No surface composes its own payment-timing sentence')
{
  // Each of the six former sources: it must READ the engine, and must no longer
  // hold the private sentence it used to. (Comment-stripped — the comments
  // explaining this fix quote the removed strings verbatim.)
  const model = stripComments(read('src/app/portal/[token]/model.ts'))
  check('portal model imports THE timing engine',
    /from '@\/lib\/payments\/paymentTiming'/.test(model))
  check('portal model no longer asserts "Nothing is charged when you approve"',
    !/Nothing is charged when you approve/i.test(model),
    'the production defect, verbatim, is back in model.ts')
  check('portal model derives the quote card line',
    /quoteTimingLine\(timing\)/.test(model))
  check('portal model carries the line on the row for components to render',
    /paymentTimingLine:\s*quoteTimingLine\(timing\)/.test(model)
    && /depositTimingLine:/.test(model))
  check('portal model passes basisSettled for an unchosen options quote',
    /basisSettled:\s*!\(options && !qq\.selected_option_id\)/.test(model))

  const home = stripComments(read('src/app/portal/[token]/components/HomeTab.tsx'))
  check('Home renders the model\'s line, not its own',
    /paymentTimingLine\}/.test(home) && !/Nothing is charged when you approve/i.test(home))

  const client = stripComments(read('src/app/portal/[token]/PortalClient.tsx'))
  check('approval dialog renders approvalTimingLine',
    /approvalTimingLine\(paymentTiming\(/.test(client))
  check('approval dialog holds no private timing branch',
    !/Approving doesn.t charge you/i.test(client),
    'the dialog is composing its own sentence again')
  check('the dialog\'s figure and its words read the SAME quote object',
    /const consented = \{/.test(client) && /requiredDeposit\(consented\)/.test(client)
    && /approvalTimingLine\(paymentTiming\(consented\)\)/.test(client))

  const billing = stripComments(read('src/app/portal/[token]/components/BillingTab.tsx'))
  check('Billing awaiting panel renders the model\'s gate-aware line',
    /\{d\.depositTimingLine\}/.test(billing))
  check('Billing satisfied panel says where the money went',
    /comes off your final invoice/i.test(billing))

  const pdf = stripComments(read('src/components/quotes/QuotePDF.tsx'))
  check('Quote PDF states the timing (it used to say nothing at all)',
    /pdfTimingLine\(timing\)/.test(pdf))
  check('Quote PDF computes timing with the options rule',
    /paymentTiming\(quote, \{ basisSettled: !\(isOptionsQuote && !chosen\) \}\)/.test(pdf))
  check('Quote PDF contains no payment arithmetic (the deposit-documents rule)',
    !/deposit_value\s*[/*]|\*\s*0?\.\d/.test(pdf))
  // Ours is the statement of record; the owner's free text sits BELOW it.
  //
  // ⚠️ Compare the RENDER SITES, not the bare identifiers. `pdfTimingLine` also
  // appears in the import at the top of the file, so an indexOf on the bare name
  // always won — the check passed against a document that printed the timing
  // BELOW the terms, and mutation #18 proved it could not fail.
  const timingAt = pdf.indexOf('{pdfTimingLine(timing)}')
  const termsAt = pdf.indexOf('{settings.terms_text}')
  check('canonical timing prints ABOVE the owner\'s free-text Terms',
    timingAt > 0 && termsAt > 0 && timingAt < termsAt,
    `terms_text is an ungoverned third source — it must not lead (timing@${timingAt}, terms@${termsAt})`)

  const bridge = stripComments(read('src/lib/portalPdf.ts'))
  check('portal PDF bridge carries the deposit rule to the customer\'s own copy',
    /deposit_type:\s*q\.deposit_type/.test(bridge) && /deposit_value:\s*q\.deposit_value/.test(bridge)
    && /accepted_price:\s*q\.accepted_price/.test(bridge),
    'without this the downloaded PDF is the one copy that cannot state the timing')
}

console.log('\n■ 4. Adjacent surfaces must not reintroduce a contradiction')
{
  // The deposit REQUEST (invoice-side engine — a different question, deliberately
  // separate) must still agree about the remainder.
  const tpl = stripComments(read('src/lib/comms/templates.ts'))
  check('deposit_request template says the balance follows the work',
    /balance is due once the work is done/i.test(tpl))
  check('deposit_request template names the amount AS a deposit',
    /we ask for a deposit of \*\*\{\{amount\}\}\*\*/i.test(tpl))
  // The quote template is deliberately SILENT on timing (the quote itself and the
  // portal carry it). Silence is safe; a contradicting promise is not.
  const quoteTpl = /quote: `([\s\S]*?)`,/.exec(tpl)?.[1] ?? ''
  check('quote template makes no payment-timing promise of its own',
    quoteTpl.length > 0 && !/charged|deposit|due/i.test(quoteTpl),
    `quote template said: ${quoteTpl.slice(0, 120)}`)
  // The booking ack fires BEFORE any quote exists — "until you say yes" is
  // consistent with both modes and must stay that way.
  check('booking_received promises only up to "yes", never past it',
    /Nothing is charged until you say yes/i.test(tpl))

  // Change orders are invoiced with the job and carry no deposit rule of their
  // own; their claim is true and must stay scoped to extra work.
  const changes = stripComments(read('src/app/portal/[token]/components/ChangesCard.tsx'))
  check('change-order copy stays scoped to the extra work it prices',
    /Nothing is charged until the work is done and invoiced/i.test(changes))

  // The scheduling gate itself: readiness is still the LEDGER's answer, so a
  // refund un-says every sentence built on it. (depositGate owns this; pinned
  // here because this guard's claims all rest on it.)
  const gateSrc = stripComments(read('src/lib/payments/depositGate.ts'))
  check('scheduling readiness is still derived, never stored',
    !/deposit_paid/.test(gateSrc) && /isCashRow/.test(gateSrc))

  // The OWNER's help describes the customer-facing copy. It taught that
  // "approving a quote never takes money", full stop — so an owner who set a
  // deposit rule had no idea what their customer was about to be asked for. A
  // help page that describes only the no-deposit branch misrepresents the
  // product back to the person configuring it.
  const help = stripComments(read('src/lib/help/content.ts'))
  check('owner help no longer says approval is the end of the money story',
    !/approving a quote never takes money/i.test(help),
    'the unqualified claim is back in help/content.ts')
  check('owner help names the scheduling deposit as what follows approval',
    /scheduling deposit\*\*, that deposit is the very next thing/i.test(help))
  check('owner help describes the deposit branch of the approval dialog',
    /also names the deposit they.ll be asked for next/i.test(help))
}

console.log(failures > 0 ? `\n✗ ${failures} FAILURE(S)` : '\n✓ all payment-timing-copy checks passed')
process.exit(failures > 0 ? 1 : 0)
