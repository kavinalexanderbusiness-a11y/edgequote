// ── What the customer sees and receives — npm run verify:customer-comms ──────
//
// Two contracts, both about the moment a customer is asked to decide something.
//
// 1. A CHOICE IS NOT A LINE ITEM.
//    A quote's ongoing per-visit rates (weekly / bi-weekly / monthly) are
//    ALTERNATIVES to one another and are not part of what is being approved.
//    They used to be concatenated into the same unlabelled `lines` list as the
//    additive scope breakdown, so a real production quote rendered as:
//        Lawn Mowing                 $50.00   <- the total
//        Weekly plan (per visit)     $45.00
//        Bi-weekly plan (per visit)  $50.00   <- the same $50, meaning something else
//    Three identical-looking rows summing to $95 against a $50 quote, with no
//    way to tell which were additions and which were alternatives. 32 of 95 live
//    quotes carry two or more of these rates.
//    ⛔ They must also never become SELECTABLE: portal_accept_quote snapshots the
//    quote total and never a cadence, so a tappable option tile would promise the
//    customer a choice the database does not record.
//
// 2. A MESSAGE ABOUT MONEY NAMES THE RIGHT NUMBER.
//    Amounts in customer messages come from the canonical engines
//    (depositChargeAmount / invoiceBalance), never from a template's own maths.
//
// Plus a product-direction check: the DEFAULT templates ship to every trade, so
// they may not carry landscaping idiom. (A tenant's own overrides may say
// anything — this pins the defaults only.)
//
// Deliberately NOT a prose lock: these assert structure, money and vocabulary,
// not the exact sentences. Rewording is allowed; changing what the customer is
// told about their money is not.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDocItems, type PortalQuote, type PortalData } from '../src/app/portal/[token]/model'
import { renderMessage, DEFAULT_TEMPLATES, type MsgType } from '../src/lib/comms/templates'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const business = { gst_percent: 0 } as unknown as PortalData['business']
const renderers = { quote: async () => new Blob(), invoice: async () => new Blob() }
const TODAY = '2026-08-10'

function quote(over: Partial<PortalQuote>): PortalQuote {
  return {
    id: 'q1', quote_number: 'Q-1', service_type: 'Lawn Mowing', address: '1 Main St',
    property_id: null, total: 50, initial_price: 50, subtotal: null,
    weekly_price: null, biweekly_price: null, monthly_price: null,
    notes: null, status: 'sent', created_at: TODAY, issued_date: TODAY,
    valid_until: '2026-09-10', crew_size: 1, hours: 0.25, travel_fee: 0,
    ...over,
  } as PortalQuote
}
const build = (q: PortalQuote) => buildDocItems({
  quotes: [q], invoices: [], properties: [], business, todayISO: TODAY, renderers,
})[0]

// ═══════════════════════════════════════════════════════════════════════════
H('A choice is not a line item')
{
  // THE reproduced case: one service, two ongoing rates, one of which happens to
  // equal the total. This is the shape that shipped.
  const d = build(quote({ total: 50, weekly_price: 45, biweekly_price: 50 }))

  check('ongoing rates are NOT in the additive breakdown', d.lines ?? null, null)
  check('…they are carried separately', (d.planOptions || []).length, 2)
  check('…and keep their real values', (d.planOptions || []).map(o => o.amount), [45, 50])

  // The defect in one assertion: nothing a customer could add up may exceed or
  // contradict the figure they are approving.
  const lineSum = (d.lines || []).reduce((s, l) => s + l.amount, 0)
  check('the visible breakdown never sums past the approved total', lineSum <= d.amount, true)
  check('the approved figure is the quote total, untouched by the rates', d.amount, 50)

  // A multi-service quote: the breakdown is additive and MUST reconcile.
  // total = Σ service nets (120 + 20) + travel (20). The breakdown the customer
  // reads includes the travel line, so it must reconcile to the same 160.
  const multi = build(quote({
    total: 160, travel_fee: 20, monthly_price: 85,
    services: [
      { service_type: 'Lawn Mowing', quantity: 2, unit: 'each', unit_price: 60, est_minutes: null, discount_type: null, discount_value: null, notes: null, sort_order: 0 },
      { service_type: 'Hedge Trim', quantity: 1, unit: 'each', unit_price: 20, est_minutes: null, discount_type: null, discount_value: null, notes: null, sort_order: 1 },
    ],
  }))
  const multiSum = (multi.lines || []).reduce((s, l) => s + l.amount, 0)
  check('a multi-service breakdown reconciles to the total', multiSum, multi.amount)
  check('…and the ongoing rate still sits outside it', (multi.planOptions || []).map(o => o.amount), [85])
  check('…so no plan rate leaks into the breakdown',
    (multi.lines || []).some(l => l.amount === 85), false)

  // Quotes with no ongoing rates must be untouched.
  const plain = build(quote({ total: 300 }))
  check('a quote with no ongoing rates has no options block', plain.planOptions ?? null, null)

  // Every rate is per-visit, and the unit has to survive: "Monthly · $260" without
  // it reads as $260/month all-in — a 4× misread found only on the first bill.
  const ui = read('src/app/portal/[token]/components/BillingTab.tsx')
  check('the UI renders options in their own labelled block',
    /d\.planOptions && d\.planOptions\.length > 0/.test(ui), true)
  check('…says they are not part of the total', /Not included in the total above/.test(ui), true)
  check('…and prints the per-visit unit', /\/ visit/.test(ui), true)
  // ⛔ The refusal that keeps the UI honest about what approving does.
  check('options are not rendered as selectable controls',
    /planOptions[\s\S]{0,900}?<(button|input|label)\b/i.test(ui), false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('A message about money names the right number')
{
  const r = renderMessage('payment_reminder', null, {
    firstName: 'Sam', businessName: 'Ace Plumbing', invoiceLink: 'https://x/y', amount: '$150.00',
  })
  check('the payment reminder states the outstanding amount', /\$150\.00/.test(r.sms), true)
  check('…and still links to pay it', /https:\/\/x\/y/.test(r.sms), true)

  // The senders must keep sourcing that figure from the ONE engine. Both of these
  // read depositChargeAmount, which is why a part-paid or deposit-bearing invoice
  // can never be chased for the wrong sum.
  const cron = read('src/app/api/cron/invoice-reminders/route.ts')
  check('the reminder cron takes its amount from the canonical engine',
    /depositChargeAmount\(/.test(cron) && /amount: formatCurrency\(due\.amount\)/.test(cron), true)
  const invoices = read('src/app/dashboard/invoices/page.tsx')
  check('the invoice composer does too', /const due = depositChargeAmount\(/.test(invoices), true)
  check('…and switches to the deposit template when one is outstanding',
    /due\.isDeposit \? 'deposit_request' : 'invoice'/.test(invoices), true)

  // A deposit ask must name the deposit, not the whole bill.
  check('the deposit template asks for {{amount}}, and calls it a deposit',
    /deposit of \*\*\{\{amount\}\}\*\*/.test(DEFAULT_TEMPLATES.deposit_request), true)

  // No default may claim to attach a document — the app sends links, not files.
  const claimsAttachment = (Object.keys(DEFAULT_TEMPLATES) as MsgType[])
    .filter(t => /attach(ed|ment)/i.test(DEFAULT_TEMPLATES[t]))
  check('no default message claims an attachment', claimsAttachment, [])
}

// ═══════════════════════════════════════════════════════════════════════════
H('The defaults ship to every trade')
{
  // These are the defaults EVERY tenant starts on (business_settings
  // .message_templates is empty until an owner edits one), so idiom from a single
  // trade is a product defect. A plumber, painter or electrician sends these too.
  const IDIOM = [
    /looking its best/i, /looking their best/i, /\bhomeowners\b/i,
    /\blawns?\b/i, /\bmow(ing|ed)?\b/i, /\byard\b/i, /\bgrass\b/i, /\bsnow\b/i,
  ]
  const offenders: string[] = []
  for (const t of Object.keys(DEFAULT_TEMPLATES) as MsgType[]) {
    for (const re of IDIOM) {
      const m = re.exec(DEFAULT_TEMPLATES[t])
      if (m) offenders.push(`${t}: "${m[0]}"`)
    }
  }
  check('no default template carries single-trade idiom', offenders, [])

  // The portal's own quote wording is universal for the same reason. Comments are
  // stripped first: model.ts documents the trade-neutral rule by NAMING the words
  // it refuses to use ("the measured area, not 'your lawn'"), and a scan that
  // reads prose it cannot tell from code reports the cure as the disease.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const model = stripComments(read('src/app/portal/[token]/model.ts'))
  const portalIdiom = /Ongoing Maintenance|lawn (care|mowing)|your lawn/i.exec(model)
  check('the portal quote block stays trade-neutral', portalIdiom ? portalIdiom[0] : null, null)

  // Rendering a default for a non-landscaping business must read correctly.
  const plumber = renderMessage('job_complete', null, { firstName: 'Sam', businessName: 'Ace Plumbing & Heating' }).sms
  check('a plumber can send the job-complete default unedited',
    /looking its best|lawn|yard/i.test(plumber), false)
  check('…and it still thanks them by company name', /Ace Plumbing & Heating/.test(plumber), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} customer-comms: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
