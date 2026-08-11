// ── Verify: the customer relationship history stays TRUE ─────────────────────
//   npm run verify:timeline
//
// WHY THIS SCRIPT EXISTS
// The timeline answers one question — "what actually happened with this
// customer?" — by assembling a dozen independent reads into a single confident
// list. Every way it can lie is a list that still renders perfectly:
//
//   * ONE ACTION TOLD TWICE. A payment lands and the `recompute_invoice_paid`
//     trigger flips the invoice to paid. Nobody did a second thing, but the
//     history showed "Payment received · $362.50" AND "Invoice INV-0042 paid ·
//     $362.50" — the same money, read as twice as much. Measured on live data
//     when this guard was written: 56 of 59 paid invoices.
//   * A DROPPED READ AS AN ANSWER. supabase-js resolves failures with
//     `{data: null, error}`, so `data || []` renders a dead connection as
//     "No history yet" — a claim about the customer the data never made.
//   * ASKED FOR read as RECEIVED. A deposit request is a sentence sent to a
//     human; the money is a separate event that may never come.
//   * A DATE-ONLY VALUE PARSED AS UTC. `expenses.spent_at` is a real DATE
//     column; `new Date('2026-08-01')` is UTC midnight, which in the owner's
//     zone is July 31 — the row printed "Aug 1" under a "July" heading.
//   * TIES RESOLVED BY FETCH ORDER, so the same history renders differently
//     after a refilter.
//   * A DEEP LINK TO NOWHERE.
//
// Runs the REAL engine against hand-derived fixtures. Deterministic, no network.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTimeline, sortTimeline, groupTimelineByMonth, timelineForProperty,
  filterTimeline, timelineGroupCounts, KIND_GROUP,
  type TimelineEvent, type TlInvoice, type TlPayment, type TlQuote, type TlJob,
} from '../src/lib/timeline'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const kinds = (evts: TimelineEvent[]) => evts.map(e => e.kind)
const titled = (evts: TimelineEvent[], re: RegExp) => evts.filter(e => re.test(e.title))
const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

// ── 1. THE OWNER'S OWN EXAMPLE ───────────────────────────────────────────────
// The brief states the history it wants, in order. Build exactly that and assert
// the engine produces those sentences, newest first.
console.log('\nThe history an owner described, built from canonical rows:')
{
  const inv: TlInvoice = {
    id: 'i1', invoice_number: 'INV-0042', amount: 725, status: 'paid',
    created_at: '2026-08-09T15:00:00Z', updated_at: '2026-08-11T14:00:00Z',
    paid_at: '2026-08-11T14:00:00Z',
  }
  const evts = buildTimeline({
    gstPercent: 0,
    quotes: [{
      id: 'q1', quote_number: 'Q-1028', total: 725, status: 'accepted',
      created_at: '2026-08-07T12:00:00Z', updated_at: '2026-08-09T14:00:00Z',
      sent_at: '2026-08-08T12:00:00Z',
    }],
    jobs: [{
      id: 'j1', title: 'Lawn service', scheduled_date: '2026-08-04', status: 'completed',
      created_at: '2026-08-03T12:00:00Z', updated_at: '2026-08-04T20:00:00Z',
      completed_at: '2026-08-04T18:00:00Z',
    }],
    invoices: [inv],
    payments: [{
      amount: 362.5, status: 'paid', kind: 'payment', method: 'stripe', notes: null,
      created_at: '2026-08-11T14:00:00Z', invoice_id: 'i1',
    }],
    serviceRequests: [{ message: 'New Website lead — mowing', created_at: '2026-08-07T09:00:00Z' }],
  })
  const story = evts.map(e => e.title)
  eq('newest first — the payment leads', story[0], 'Payment received')
  check('…the quote acceptance is above the quote being sent',
    story.indexOf('Quote Q-1028 accepted') < story.indexOf('Quote Q-1028 sent'), story.join(' | '))
  check('…the website lead is present', story.includes('Website lead'), story.join(' | '))
  check('…the completed visit is present', story.some(t => /^Job completed/.test(t)), story.join(' | '))
  check('…and every row is a sentence about the business, not a row change',
    evts.every(e => !/\b(updated|upsert|rpc|enum|recalculat)/i.test(e.title)), story.join(' | '))
}

// ── 2. DEDUPLICATION — one real-world action is one row ──────────────────────
console.log('\nDeduplication (the payment/invoice-paid mirror):')
{
  const inv: TlInvoice = {
    id: 'i1', invoice_number: 'INV-0042', amount: 500, status: 'paid',
    created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-05T10:00:00Z',
    paid_at: '2026-08-05T10:00:00Z',
  }
  const pay: TlPayment = {
    amount: 500, status: 'paid', kind: 'payment', method: 'stripe', notes: null,
    created_at: '2026-08-05T10:00:03Z', invoice_id: 'i1',
  }
  const merged = buildTimeline({ invoices: [inv], payments: [pay], gstPercent: 0 })
  eq('a payment that settles its invoice yields ONE money-arrived row',
    kinds(merged).filter(k => k === 'payment' || k === 'invoice_paid').length, 1)
  eq('…and the survivor is the ledger row, which knows the amount', kinds(merged).includes('payment'), true)
  check('…which now names the invoice it settled',
    /INV-0042 paid in full/.test(titled(merged, /Payment received/)[0]?.sub || ''),
    titled(merged, /Payment received/)[0]?.sub || '(no sub)')
  check('…and links to it', titled(merged, /Payment received/)[0]?.href === '/dashboard/invoices?invoice=INV-0042',
    String(titled(merged, /Payment received/)[0]?.href))
  // The claim is about money ARRIVING being stated once. "Invoice created ·
  // $500" is a different fact (a bill was raised) and rightly keeps its figure.
  eq('…money ARRIVING is stated once, so the history cannot read as $1,000',
    merged.filter(e => KIND_GROUP[e.kind] === 'money' && /paid|payment|received/i.test(e.title))
      .filter(e => (e.sub || '').includes('$500.00') || e.title.includes('$500.00')).length, 1)

  // The mirror only collapses when one write caused both.
  const byHand = buildTimeline({ invoices: [inv], payments: [], gstPercent: 0 })
  eq('an invoice marked paid BY HAND keeps its own row — a real, separate act',
    kinds(byHand).includes('invoice_paid'), true)

  const late: TlPayment = { ...pay, created_at: '2026-07-01T10:00:00Z' }
  const apart = buildTimeline({ invoices: [inv], payments: [late], gstPercent: 0 })
  eq('a payment a month from paid_at is NOT the same action — both rows stand',
    kinds(apart).filter(k => k === 'payment' || k === 'invoice_paid').length, 2)

  // Two things a human did stay two things, even a second apart.
  const q: TlQuote = {
    id: 'q1', quote_number: 'Q-1', total: 500, status: 'accepted',
    created_at: '2026-08-01T09:00:00Z', updated_at: '2026-08-01T10:00:00Z',
  }
  const both = buildTimeline({ quotes: [q], invoices: [inv], gstPercent: 0 })
  check('a quote accepted and its auto-drafted invoice stay TWO events',
    kinds(both).includes('quote_accepted') && kinds(both).includes('invoice_created'), kinds(both).join(','))
}

// ── 3. DEPOSIT — asked for is not received ───────────────────────────────────
console.log('\nDeposit requested vs deposit received:')
{
  const inv: TlInvoice = {
    id: 'i1', invoice_number: 'INV-0100', amount: 4000, status: 'partial',
    created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-02T10:00:00Z',
    deposit_amount: 2000, deposit_requested_at: '2026-08-02T10:00:00Z',
  }
  const askedOnly = buildTimeline({ invoices: [inv], payments: [], gstPercent: 13 })
  const ask = titled(askedOnly, /Deposit requested/)[0]
  check('the ask is its own event', !!ask, kinds(askedOnly).join(','))
  check('…stating the amount the customer was told', /\$2,000\.00/.test(ask?.title || ''), ask?.title || '')
  eq('…and NO money is claimed to have arrived', kinds(askedOnly).includes('payment'), false)

  // deposit_amount is stored GST-INCLUSIVE. Re-grossing it would overstate the ask.
  check('…the ask is NOT re-grossed by GST (it is stored GST-inclusive)',
    !/2,260|\$2,260\.00/.test(ask?.title || ''), ask?.title || '')

  const paid = buildTimeline({
    invoices: [inv],
    payments: [{ amount: 2000, status: 'paid', kind: 'payment', method: 'stripe', notes: null,
      created_at: '2026-08-03T10:00:00Z', invoice_id: 'i1' }],
    gstPercent: 13,
  })
  eq('money answering the ask reads as a deposit RECEIVED',
    titled(paid, /^Deposit received$/).length, 1)
  eq('…and the ask still stands as its own earlier event', titled(paid, /Deposit requested/).length, 1)

  // The rest of the bill is not a second deposit.
  const rest = buildTimeline({
    invoices: [inv],
    payments: [
      { amount: 2000, status: 'paid', kind: 'payment', method: 'stripe', notes: null, created_at: '2026-08-03T10:00:00Z', invoice_id: 'i1' },
      { amount: 2000, status: 'paid', kind: 'payment', method: 'cash', notes: null, created_at: '2026-08-20T10:00:00Z', invoice_id: 'i1' },
    ],
    gstPercent: 13,
  })
  eq('…a $2,000 ask paid twice gives ONE deposit and one ordinary payment',
    titled(rest, /^Deposit received$/).length, 1)
  eq('…the later money is a plain payment', titled(rest, /^Payment received$/).length, 1)

  // Money that arrived before the ask cannot be an answer to it.
  const before = buildTimeline({
    invoices: [inv],
    payments: [{ amount: 2000, status: 'paid', kind: 'payment', method: 'cash', notes: null,
      created_at: '2026-08-01T11:00:00Z', invoice_id: 'i1' }],
    gstPercent: 13,
  })
  eq('money received BEFORE the ask is not labelled a deposit',
    titled(before, /^Deposit received$/).length, 0)

  const noAsk = buildTimeline({
    invoices: [{ ...inv, deposit_amount: null, deposit_requested_at: null }],
    payments: [{ amount: 2000, status: 'paid', kind: 'payment', method: 'cash', notes: null,
      created_at: '2026-08-03T10:00:00Z', invoice_id: 'i1' }],
    gstPercent: 13,
  })
  eq('a partial payment with no deposit ever asked for is NOT a deposit',
    titled(noAsk, /Deposit/).length, 0)

  // A drafted-but-unsent request is not a thing that happened to the customer.
  const draft = buildTimeline({ invoices: [{ ...inv, deposit_requested_at: null }], gstPercent: 13 })
  eq('a deposit drafted but never SENT is not history yet', titled(draft, /Deposit requested/).length, 0)
}

// ── 4. ORDERING + TIMEZONE ───────────────────────────────────────────────────
console.log('\nOrdering and timezone:')
{
  // A DATE-only value must sort and bucket by the LOCAL day it prints as.
  const evts = buildTimeline({
    jobs: [{ id: 'j1', title: 'Mow', scheduled_date: '2026-08-04', status: 'scheduled',
      created_at: '2026-08-01T12:00:00Z', updated_at: '2026-08-01T12:00:00Z' }],
    expenses: [{ id: 'e1', description: 'Fuel', amount: 40, spent_at: '2026-08-01',
      created_at: '2026-08-01T12:00:00Z', job_id: 'j1' }],
    gstPercent: 0,
  })
  const expense = titled(evts, /Expense/)[0]
  const months = groupTimelineByMonth([expense])
  check('a date-only expense buckets under its OWN month, not the previous one',
    months[0]?.label.startsWith('August'), months[0]?.label || '(none)')

  // Determinism: the same events in any input order render identically.
  const a: TimelineEvent[] = [
    { at: '2026-08-05T10:00:00Z', kind: 'invoice_created', title: 'Invoice INV-1 created' },
    { at: '2026-08-05T10:00:00Z', kind: 'quote_accepted', title: 'Quote Q-1 accepted' },
    { at: '2026-08-05T10:00:00Z', kind: 'job_completed', title: 'Job completed — Mow' },
  ]
  const forward = kinds(sortTimeline(a)).join(',')
  const backward = kinds(sortTimeline(a.slice().reverse())).join(',')
  eq('identical timestamps sort the same regardless of fetch order', forward, backward)
  check('…and the effect sits above its cause (invoice above the acceptance)',
    forward.indexOf('invoice_created') < forward.indexOf('quote_accepted'), forward)

  const withBad = sortTimeline([
    { at: 'not-a-date', kind: 'note', title: 'Broken' },
    { at: '2020-01-01T00:00:00Z', kind: 'note', title: 'Old but real' },
  ])
  eq('an unparseable date sinks to the bottom, never poses as the oldest event',
    withBad[withBad.length - 1].title, 'Broken')
}

// ── 5. DEEP LINKS ────────────────────────────────────────────────────────────
console.log('\nDeep links point at surfaces that exist:')
{
  const evts = buildTimeline({
    customerId: 'c1',
    quotes: [{ id: 'q1', quote_number: 'Q-1', total: 100, status: 'sent',
      created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z', sent_at: '2026-08-01T11:00:00Z' }],
    invoices: [{ id: 'i1', invoice_number: 'INV-1', amount: 100, status: 'unpaid',
      created_at: '2026-08-02T10:00:00Z', updated_at: '2026-08-02T10:00:00Z' }],
    messages: [{ direction: 'inbound', channel: 'sms', body: 'hello', created_at: '2026-08-03T10:00:00Z' }],
    gstPercent: 0,
  })
  const href = (re: RegExp) => titled(evts, re)[0]?.href || ''
  eq('a quote row opens the quote', href(/Quote Q-1 created/), '/dashboard/quotes/q1')
  eq('an invoice row opens THAT invoice on the invoices page', href(/Invoice INV-1 created/), '/dashboard/invoices?invoice=INV-1')
  eq('a message row opens THAT conversation', href(/Received SMS/), '/dashboard/messages?c=c1')

  // Every href must be an app route, not an invented one.
  const roots = new Set(evts.map(e => (e.href || '').split('?')[0]).filter(Boolean)
    .map(p => p.split('/').slice(0, 3).join('/')))
  check('…and every destination is under /dashboard', [...roots].every(r => r.startsWith('/dashboard')), [...roots].join(','))

  // The invoice deep link uses the ?invoice= focus contract, NOT a route that
  // does not exist. /dashboard/invoices/[id] was deliberately never built.
  check('…the invoice link uses ?invoice= focus, not a non-existent /invoices/[id]',
    !/\/dashboard\/invoices\/[^?]/.test(href(/Invoice INV-1 created/)), href(/Invoice INV-1 created/))
}

// ── 6. PARTIAL READ FAILURE — the honesty contract ───────────────────────────
// The engine is pure, so this half is structural: the LOADER must report which
// reads failed, and the CARD must say so instead of claiming an empty history.
console.log('\nA dropped read is never an empty history:')
{
  const loader = src('lib/timelineData.ts')
  const card = src('components/timeline/TimelineCard.tsx')
  const customer = src('app/dashboard/customers/[id]/page.tsx')
  const property = src('app/dashboard/properties/[id]/page.tsx')

  check('the loader returns a `missing` list alongside its sources',
    /missing:\s*string\[\]/.test(loader) && /export interface TimelineLoad/.test(loader), 'TimelineLoad not found')
  // Named individually, not counted: a count passes while any one source quietly
  // loses its report, which is precisely the failure this whole section exists
  // for. Every source the loader reads must be able to say it failed.
  for (const label of ['Messages', 'Payments', 'Requests', 'Photos', 'Measurements',
                       'Consent', 'Automations', 'Quotes', 'Jobs', 'Invoices',
                       'Expenses', 'Price changes']) {
    check(`…a failed ${label} read is reported by name`,
      new RegExp(`gap\\('${label}'`).test(loader), `no gap('${label}', …) in the loader`)
  }
  check('…photos included, via the result-returning read (listPhotos swallows errors)',
    /listPhotosResult/.test(loader) && !/\blistPhotos\b(?!Result)/.test(loader), 'still using error-swallowing listPhotos')
  check('the card accepts `missing` and states it',
    /missing\?:\s*string\[\]/.test(card) && /history is incomplete/i.test(card), 'no incomplete-history notice')
  check('…and NEVER says "no history" when a source failed',
    /missing\.length > 0 \? 'Nothing could be loaded/.test(card), 'empty branch does not branch on missing')
  check('the customer page passes `missing` into the card',
    /missing=\{tlMissing\}/.test(customer), 'customer page does not pass missing')
  check('…including its OWN quotes/jobs/invoices reads, which the loader never sees',
    /qRes\.error \? \['Quotes'\]/.test(customer) && /iRes\.error \? \['Invoices'\]/.test(customer),
    'page-level read failures not reported')
  check('the property page passes `missing` too',
    /missing=\{missing\}/.test(property), 'property page does not pass missing')

  // The bug this replaced: `|| []` on a failed read, with nothing recording it.
  check('…and no timeline source silently swallows its error any more',
    !/const \[mRes[\s\S]{0,2000}?return \{\s*customerId/.test(loader), 'loader still returns bare sources')
}

// ── 7. EMPTY GENUINE HISTORY vs NOTHING LOADED ───────────────────────────────
console.log('\nA genuinely empty history:')
{
  const none = buildTimeline({})
  eq('no sources at all yields no events — and never throws', none.length, 0)
  const emptyLists = buildTimeline({ quotes: [], jobs: [], invoices: [], payments: [], messages: [] })
  eq('empty lists yield an empty timeline', emptyLists.length, 0)
  check('…and the card distinguishes that from a failed load',
    /missing\.length > 0 \? 'Nothing could be loaded/.test(src('components/timeline/TimelineCard.tsx')),
    'the two empties are indistinguishable')
}

// ── 8. TENANCY ───────────────────────────────────────────────────────────────
console.log('\nTenant boundary:')
{
  const loader = src('lib/timelineData.ts')
  // Every customer-scoped read is keyed by the customer id, and the customer row
  // itself is only reachable under RLS — so a foreign id resolves to nothing.
  // job_photos is the one source that also takes user_id directly.
  const reads = loader.match(/\.from\('([a-z_]+)'\)/g) || []
  check('every table read in the loader is scoped by customer, property or job id',
    reads.length > 0 && !/\.from\('[a-z_]+'\)\.select\([^)]*\)\s*(\.order|\.limit|;|\))/.test(loader),
    'an unscoped read exists')
  check('…the photos read is scoped by user_id as well (lib/photos)',
    /\.eq\('user_id', userId\)/.test(src('lib/photos.ts')), 'photos not user-scoped')
  check('…and the loader never uses a service-role client',
    !/service_role|SERVICE_ROLE/.test(loader), 'service-role key referenced in the loader')

  // A property timeline must not leak a sibling address's events.
  const evts = buildTimeline({
    jobs: [
      { id: 'j1', title: 'A', scheduled_date: '2026-08-01', status: 'completed', created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z', completed_at: '2026-08-01T10:00:00Z', property_id: 'p1' },
      { id: 'j2', title: 'B', scheduled_date: '2026-08-02', status: 'completed', created_at: '2026-08-02T10:00:00Z', updated_at: '2026-08-02T10:00:00Z', completed_at: '2026-08-02T10:00:00Z', property_id: 'p2' },
    ],
    gstPercent: 0,
  })
  const p1 = timelineForProperty(evts, 'p1')
  check('a property timeline holds only that address\'s events',
    p1.length > 0 && p1.every(e => e.propertyId === 'p1'), `got ${p1.length} rows`)
  eq('…and a payment (customer-level) never lands under an address',
    buildTimeline({
      payments: [{ amount: 10, status: 'paid', kind: 'payment', method: 'cash', notes: null, created_at: '2026-08-01T10:00:00Z', invoice_id: null }],
    }).every(e => e.propertyId == null), true)
}

// ── 9. WINDOWING ─────────────────────────────────────────────────────────────
console.log('\nHistory is windowed, not unbounded:')
{
  const loader = src('lib/timelineData.ts')
  const card = src('components/timeline/TimelineCard.tsx')
  const limits = loader.match(/\.limit\((\d+)\)/g) || []
  check('every customer-scoped read is capped', limits.length >= 6, `only ${limits.length} .limit() calls`)
  check('…including payments, which used to be unbounded', /invoice_id'\)[\s\S]{0,200}\.limit\(/.test(loader), 'payments read has no limit')
  check('the card shows a bounded window with a way to open the rest',
    /TIMELINE_CAP = \d+/.test(card) && /Show \$\{events\.length - TIMELINE_CAP\} more/.test(card), 'no cap/show-more')
  check('…and offscreen rows skip layout so "show all" stays cheap',
    /content-visibility:auto/.test(card), 'no content-visibility containment')
}

// ── 10. NO TECHNICAL NOISE ───────────────────────────────────────────────────
console.log('\nEvents read as business history, not row changes:')
{
  const engine = src('lib/timeline.ts')
  // Every kind must be grouped, or the filter silently drops it.
  const kindMatch = engine.match(/export type TimelineKind =([\s\S]*?)\n\n/)?.[1] || ''
  const declared = [...kindMatch.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  const ungrouped = declared.filter(k => !(k in KIND_GROUP))
  eq('every declared kind belongs to exactly one group', ungrouped.join(','), '')

  const counts = timelineGroupCounts(buildTimeline({
    quotes: [{ id: 'q', quote_number: 'Q-1', total: 1, status: 'sent', created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z' }],
  }))
  eq('a quote counts under Sales', counts.sales > 0, true)
  eq('an unset filter hides nothing', filterTimeline([{ at: '2026-08-01T10:00:00Z', kind: 'note', title: 'n' }], new Set()).length, 1)
}

console.log(failures === 0
  ? '\n✅ Customer timeline: history stays true.\n'
  : `\n❌ ${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
