// Customer-portal model regression suite — `npm run verify:portal`.
//
// The portal's failure modes are wrong-VALUE bugs invisible to tsc: a payload
// key silently dropped in normalize (the services bug shipped exactly that
// way), a legacy quote borrowing the primary property's measured area (the 25×
// false-claim bug), a draft invoice shown as payable, an expired quote still
// explaining its price. These checks run the REAL model functions the page
// renders from — no mocks, no network.

import {
  normalizePortal, buildDerived, buildDocItems, buildPortalView,
  quoteJourney, moneySummary, refundedTotal, buildPropertyModels, customerSinceYear,
  requestPresetsOf, resolveDocAddress, groupPhotos, orphanPhotos, liveStatusOf, visitDay,
  daysAwayLabel, dueSoonLabel, invoiceDepositNote, invoiceDepositPaidNote, invoicePaymentNote, parsePortalDeepLink, tabNavTarget, buildVisitICS, visitToCalendarEvent,
  messageAboutDoc, primaryPortalAction, draftStorageKey, etransferReference, isSendChord,
  contactGap, isUsablePhone, isUsableEmail, PHONE_MIN_DIGITS, recentPaymentLanded,
  showDocFilters, DOC_FILTER_MIN, recentPayments, RECENT_PAYMENT_MAX,
  NO_PROPERTY, MAX_REQUEST_PRESETS,
  type PortalData, type PortalJob, type PortalProperty, type DocBlobRenderers,
} from '../src/app/portal/[token]/model'
// The PDF logo bound — the fix for the invoice a customer could list but not open.
import { pdfLogoUrl, PDF_LOGO_MAX_PX } from '../src/lib/photos'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const TODAY = '2026-07-18'
const renderers: DocBlobRenderers = {
  quote: async () => new Blob(['q']),
  invoice: async () => new Blob(['i']),
}

const PROP_A: PortalProperty = { id: 'prop-a', address: '12 Main St SW', city: 'Calgary', province: 'AB', postal_code: null, lawn_sqft: 4200, fence_length: 120, neighborhood: 'Aspen', is_primary: true }
const PROP_B: PortalProperty = { id: 'prop-b', address: '99 Rental Ave NE', city: 'Calgary', province: 'AB', postal_code: null, lawn_sqft: 407, fence_length: null, neighborhood: null, is_primary: false }

const job = (over: Partial<PortalJob>): PortalJob => ({
  id: 'j1', recurrence_id: null, property_id: PROP_A.id, quote_id: null, price: 65,
  is_initial_visit: null, service_type: 'Mowing', title: 'Mowing', scheduled_date: '2026-07-20',
  status: 'scheduled', on_my_way_at: null, started_at: null, completed_at: null, completion_summary: null, ...over,
})

// A payload carrying EVERY key the live RPC sends — the round-trip tripwire.
const FULL: PortalData = {
  customer: { id: 'c1', name: 'Jordan Miller', email: 'j@x.com', phone: '403-555-0142', address: '12 Main St SW', city: 'Calgary', sms_opt_in: true, email_opt_in: false, reviewed_at: null, review_declined_at: null, autopay_enabled: false },
  business: { company_name: 'Edge Co', owner_name: 'Kavin', phone: '403-000-0000', email_primary: 'a@b.c', email_secondary: null, website: 'edge.co', logo_url: null, logo_scale: null, base_address: null, terms_text: 'Be kind.', review_url: 'g.page/x', etransfer_email: 'pay@edge.co', gst_percent: 5, gst_number: '123456789RT0001', service_seasons: null },
  property: { address: PROP_A.address, city: 'Calgary', province: 'AB', lawn_sqft: 4200, fence_length: 120, neighborhood: 'Aspen', notes: 'Gate code 4321' },
  properties: [PROP_A, PROP_B],
  quotes: [
    { id: 'q-sent', quote_number: 'Q-1', service_type: 'Mowing', address: '12 Main Street Southwest', property_id: PROP_A.id, total: 65, initial_price: null, subtotal: null, weekly_price: 40, biweekly_price: null, monthly_price: null, notes: null, status: 'sent', created_at: '2026-07-10T10:00:00Z', issued_date: '2026-07-10', valid_until: '2026-08-09', crew_size: 2, hours: 0.75, travel_fee: 10, services: null },
    { id: 'q-legacy', quote_number: 'Q-2', service_type: 'Cleanup', address: '99 Rental Ave NE', property_id: null, total: 40, initial_price: null, subtotal: null, weekly_price: null, biweekly_price: null, monthly_price: null, notes: null, status: 'sent', created_at: '2026-07-11T10:00:00Z', issued_date: '2026-07-11', valid_until: null, crew_size: null, hours: null, travel_fee: null, services: null },
    { id: 'q-exp', quote_number: 'Q-3', service_type: 'Aeration', address: '12 Main St SW', property_id: PROP_A.id, total: 90, initial_price: null, subtotal: null, weekly_price: null, biweekly_price: null, monthly_price: null, notes: null, status: 'sent', created_at: '2026-06-01T10:00:00Z', issued_date: '2026-06-01', valid_until: '2026-07-01', crew_size: null, hours: null, travel_fee: null, services: null },
    { id: 'q-paid', quote_number: 'Q-4', service_type: 'Mowing', address: '12 Main St SW', property_id: PROP_A.id, total: 65, initial_price: null, subtotal: null, weekly_price: null, biweekly_price: null, monthly_price: null, notes: null, status: 'paid', created_at: '2026-06-20T10:00:00Z', issued_date: '2026-06-20', valid_until: null, crew_size: null, hours: null, travel_fee: null, services: null },
  ],
  invoices: [
    { id: 'i-due', invoice_number: 'INV-1', service_type: 'Mowing', amount: 100, status: 'unpaid', issued_date: '2026-07-12', due_date: '2026-07-26', notes: null, address: '12 Main St SW', property_id: PROP_A.id, line_items: null, job_id: 'j-done', created_at: '2026-07-12T10:00:00Z', discount_type: null, discount_value: null, amount_paid: 0 },
    { id: 'i-late', invoice_number: 'INV-2', service_type: 'Cleanup', amount: 200, status: 'partial', issued_date: '2026-06-10', due_date: '2026-07-01', notes: null, address: null, property_id: null, line_items: null, job_id: null, created_at: '2026-06-10T10:00:00Z', discount_type: null, discount_value: null, amount_paid: 100 },
    { id: 'i-draft', invoice_number: 'INV-3', service_type: null, amount: 50, status: 'draft', issued_date: null, due_date: null, notes: null, address: null, property_id: null, line_items: null, job_id: null, created_at: '2026-07-15T10:00:00Z', amount_paid: 0 },
    { id: 'i-paid', invoice_number: 'INV-4', service_type: 'Mowing', amount: 60, status: 'paid', issued_date: '2026-05-01', due_date: '2026-05-15', notes: null, address: null, property_id: PROP_B.id, line_items: null, job_id: null, created_at: '2026-05-01T10:00:00Z', amount_paid: 63 },
  ],
  jobs: [
    job({ id: 'j-up1', scheduled_date: '2026-07-20' }),
    job({ id: 'j-up2', scheduled_date: '2026-07-19', property_id: PROP_B.id }),
    // Rain-delayed: scheduled BEFORE j-old but completed AFTER — must sort first.
    job({ id: 'j-done', scheduled_date: '2026-07-01', status: 'completed', completed_at: '2026-07-10T18:00:00Z' }),
    job({ id: 'j-old', scheduled_date: '2026-07-05', status: 'completed', completed_at: '2026-07-05T18:00:00Z' }),
  ],
  recurrences: [],
  photos: [
    { id: 'p1', job_id: 'j-done', storage_path: 'a.jpg', kind: 'before', caption: null, taken_at: '2026-07-10T17:00:00Z' },
    { id: 'p2', job_id: 'j-done', storage_path: 'b.jpg', kind: 'after', caption: null, taken_at: '2026-07-10T18:00:00Z' },
    { id: 'p3', job_id: null, storage_path: 'c.jpg', kind: 'other', caption: null, taken_at: '2026-07-01T18:00:00Z' },
  ],
  payments: [{ id: 'pay1', amount: 63, status: 'paid', paid_at: '2026-05-02T10:00:00Z', provider: 'stripe', invoice_id: 'i-paid', created_at: '2026-05-02T10:00:00Z', kind: 'payment' }],
  payment_method: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2027 },
  services: [
    { name: 'Mowing', category: 'Lawn', default_rate: 65, pricing_display_type: 'starting_from', default_description: 'Weekly cuts', sort_order: 1 } as never,
    { name: '  ', category: null, default_rate: null, pricing_display_type: null, default_description: null, sort_order: 2 } as never,
  ],
}

// ── normalize: the silent-drop tripwire ─────────────────────────────────────
console.log('\nnormalizePortal (round-trip — a dropped key fails here):')
{
  const n = normalizePortal(JSON.parse(JSON.stringify(FULL)))!
  check('null in → null out', normalizePortal(null) === null)
  for (const key of Object.keys(FULL) as (keyof PortalData)[]) {
    check(`carries '${key}'`, JSON.stringify(n[key]) === JSON.stringify(FULL[key]), 'key dropped or altered — the services bug again')
  }
  const g = normalizePortal({ customer: FULL.customer, quotes: 'garbage' })!
  check('garbage collection coerced to []', Array.isArray(g.quotes) && g.quotes.length === 0)
  check('missing business → null (not crash)', g.business === null)
}

// ── small facts ─────────────────────────────────────────────────────────────
console.log('\nSmall facts:')
check('liveStatusOf: completed_at wins', liveStatusOf(job({ completed_at: 'x', status: 'scheduled' })) === 'completed')
check('liveStatusOf: on_my_way', liveStatusOf(job({ on_my_way_at: 'x' })) === 'on_my_way')
check('visitDay: completion day beats scheduled day', visitDay(job({ scheduled_date: '2026-07-01', completed_at: '2026-07-10T18:00:00Z' })) === '2026-07-10')
check('daysAwayLabel: Today/Tomorrow', daysAwayLabel(TODAY, TODAY) === 'Today' && daysAwayLabel('2026-07-19', TODAY) === 'Tomorrow')
check('daysAwayLabel: silent beyond 14d and for the past', daysAwayLabel('2026-08-10', TODAY) === null && daysAwayLabel('2026-07-01', TODAY) === null)
check('groupPhotos: none bucket', groupPhotos(FULL.photos).get('none')?.length === 1)
// The adversarial-audit regression: a photo on a NOT-completed job must stay
// viewable (it used to live in the Photos tab). orphanPhotos = every photo the
// completed-visit cards won't show.
{
  const completedIds = new Set(['j-done', 'j-old'])
  const withInProgress = [...FULL.photos, { id: 'p-ip', job_id: 'j-up1', storage_path: 'ip.jpg', kind: 'before', caption: null, taken_at: '2026-07-19T09:00:00Z' }]
  const orphans = orphanPhotos(withInProgress, completedIds)
  check('orphanPhotos: keeps the in-progress-job photo (the regression)', orphans.some(p => p.id === 'p-ip'))
  check('orphanPhotos: keeps the loose (no-job) photo', orphans.some(p => p.id === 'p3'))
  check('orphanPhotos: DROPS completed-visit photos (shown on the card)', !orphans.some(p => p.job_id && completedIds.has(p.job_id)))
  check('orphanPhotos: newest-first', orphans[0].taken_at >= orphans[orphans.length - 1].taken_at)
}
check('resolveDocAddress: canonical wins over stale copy', resolveDocAddress(new Map([[PROP_A.id, PROP_A]]), PROP_A.id, '12 Main Street Southwest') === PROP_A.address)
check('resolveDocAddress: falls back on unknown id', resolveDocAddress(new Map(), 'ghost', 'Own Text') === 'Own Text')

// ── derived ─────────────────────────────────────────────────────────────────
console.log('\nbuildDerived:')
const derived = buildDerived(FULL, TODAY)
check('upcoming sorted soonest-first', derived.upcoming.map(j => j.id).join(',') === 'j-up2,j-up1')
check('completed sorted by the day work HAPPENED (rain-delay case)', derived.completed.map(j => j.id).join(',') === 'j-done,j-old')
check('lastCompleted is the rain-delayed visit', derived.lastCompleted?.id === 'j-done')
// invoiceTotals adds 5% GST: due = 105 (i-due) + (210-100=110) (i-late) + 0 (draft excl) + 0 (paid) = 215
check('outstanding: GST-true, partial-aware, draft/cancelled excluded', Math.abs(derived.outstanding - 215) < 0.01, String(derived.outstanding))

// ── documents ───────────────────────────────────────────────────────────────
console.log('\nbuildDocItems (the honesty rules):')
const docs = buildDocItems({ quotes: FULL.quotes, invoices: FULL.invoices, properties: FULL.properties!, business: FULL.business, todayISO: TODAY, renderers })
const byId = new Map(docs.map(d => [d.rawId, d]))
check('draft invoice is NOT shown', !byId.has('i-draft'))
check('count = quotes + non-draft invoices', docs.length === 4 + 3, String(docs.length))
{
  const sent = byId.get('q-sent')!
  check('sent quote: display status sent', sent.status === 'sent')
  check('sent quote: measured-area claim uses ITS OWN property', sent.explain?.some(s => s.includes('4,200')) === true)
  check('sent quote: GST amountNote present', sent.amountNote?.includes('GST') === true)
  // Ongoing rates are ALTERNATIVES to each other, so they left `lines` — which is
  // additive and reconciles to `amount` — for `planOptions`. What this check has
  // always protected is unchanged and now stronger: a customer must never be able
  // to read an ongoing rate as part of what they are approving. The per-visit UNIT
  // that prevents the "$260/month all-in" 4× misread moved to the renderer with
  // them, and is pinned by verify:customer-comms.
  // Asserted on VALUES, not labels: a label check written against today's wording
  // ("Weekly plan (per visit)") silently stops catching anything the moment the
  // wording changes, which is exactly how a flattened list would creep back.
  // Two independent ways to fail: a rate appearing among the additive lines, or
  // the additive lines no longer reconciling to the figure being approved.
  const planAmts = new Set((sent.planOptions ?? []).map(o => o.amount))
  const lineSum = (sent.lines ?? []).reduce((s, l) => s + l.amount, 0)
  check('sent quote: ongoing rates are choices, never additive lines',
    (sent.planOptions?.length ?? 0) > 0
    && !(sent.lines ?? []).some(l => planAmts.has(l.amount))
    && (sent.lines === undefined || Math.abs(lineSum - sent.amount) < 0.005))
  check('sent quote: nothing-charged promise present', sent.explain?.some(s => s.startsWith('Nothing is charged')) === true)
  check('sent quote: canonical address wins over stale copy', sent.address === PROP_A.address)
  const legacy = byId.get('q-legacy')!
  check('LEGACY quote: NO area claim (the 25× fix)', !legacy.explain?.some(s => s.includes('sq ft')))
  check('legacy quote: falls back to its own address text', legacy.address === '99 Rental Ave NE')
  const exp = byId.get('q-exp')!
  check('expired: derived overlay, never stored', exp.status === 'expired' && FULL.quotes[2].status === 'sent')
  check('expired: price is NOT explained', exp.explain === undefined)
  check('expired: expiredOn carries the lapse date', exp.expiredOn === '2026-07-01')
  const late = byId.get('i-late')!
  check('overdue: display overlay from due_date', late.status === 'overdue')
  check('partial: no faint amountNote (breakdown moved to invoicePaymentNote)', late.amountNote === undefined)
  check('invoice balance is GST-true minus paid', Math.abs(late.balance - 110) < 0.01, String(late.balance))
  check('multi-property invoice with null property stays unassigned', late.propertyId === null)
  const due = byId.get('i-due')!
  check('due invoice: amount is the GST-true total', Math.abs(due.amount - 105) < 0.01)
}

// ── journey ─────────────────────────────────────────────────────────────────
console.log('\nquoteJourney (progress = display of existing state):')
for (const [status, idx] of [['sent', 0], ['accepted', 1], ['scheduled', 2], ['completed', 3], ['paid', 4]] as const) {
  const steps = quoteJourney(status)!
  check(`${status} → current at step ${idx}, ${idx} done before it`,
    steps.findIndex(s => s.current) === idx && steps.filter(s => s.done).length === idx)
}
check('declined gets NO rail', quoteJourney('declined') === null)
check('expired gets NO rail', quoteJourney('expired') === null)
check('rail ends at Paid', quoteJourney('sent')![4].label === 'Paid')

// ── money ───────────────────────────────────────────────────────────────────
console.log('\nmoneySummary:')
{
  const m = moneySummary(FULL.invoices, FULL.business)
  // invoiced = 105 + 210 + 63 (draft excluded); paid = 0 + 100 + min(63,63); due = 105 + 110
  check('invoiced excludes drafts', Math.abs(m.invoiced - 378) < 0.01, String(m.invoiced))
  check('paid capped per-invoice at its total (overpay ≠ inflation)', Math.abs(m.paid - 163) < 0.01, String(m.paid))
  check('due matches derived.outstanding', Math.abs(m.due - 215) < 0.01)
  check('owingCount counts invoices with balance', m.owingCount === 2)
}

// ── refundedTotal: a refund is cash OUT, never an overpayment moved to credit ──
console.log('\nrefundedTotal (the money shows once):')
{
  const pmt = (o: Record<string, unknown>) => ({ id: 'x', amount: 0, status: 'paid', paid_at: '2026-05-01T00:00:00Z', provider: 'stripe', invoice_id: 'i-paid', created_at: '2026-05-01T00:00:00Z', kind: 'payment', ...o }) as never
  const payment = pmt({ id: 'p1', amount: 100 })
  const refund = pmt({ id: 'p2', amount: -30, provider: 'refund' })            // real cash out
  const toCredit = pmt({ id: 'p3', amount: -50, provider: 'credit' })          // overpayment MOVED to credit — not cash
  const creditGrant = pmt({ id: 'p4', amount: 50, kind: 'credit', provider: 'credit' })
  // The bug: sign-based math counted the -50 credit move as a refund → |−30−50| = 80,
  // the SAME $50 also shown as Available credit. The classifier counts only real cash out.
  check('refundedTotal counts only the real cash refund (30), not the credit move', refundedTotal([payment, refund, toCredit, creditGrant]) === 30, String(refundedTotal([payment, refund, toCredit, creditGrant])))
  check('an overpayment-to-credit leg alone is $0 refunded (it is Available credit)', refundedTotal([toCredit, creditGrant]) === 0)
  check('no negative rows → nothing refunded', refundedTotal([payment]) === 0)
}

// ── properties ──────────────────────────────────────────────────────────────
console.log('\nbuildPropertyModels (grouping law):')
{
  const multi = buildPropertyModels(FULL, derived, groupPhotos(FULL.photos))
  check('multi: one model per property, primary first', multi[0].key === PROP_A.id && multi[1].key === PROP_B.id)
  check('multi: strict buckets (B gets its own upcoming visit)', multi[1].upcoming.some(j => j.id === 'j-up2') && !multi[0].upcoming.some(j => j.id === 'j-up2'))
  check('multi: photos counted through the property\'s own visits', multi[0].photoCount === 2 && multi[1].photoCount === 0)
  check('multi: doc counts are per-property (draft excluded)', multi[0].invoiceCount === 1 && multi[1].invoiceCount === 1)
  check('multi: orphan bucket appears (null-property invoice exists)', multi.some(m => m.key === NO_PROPERTY))
  const single: PortalData = { ...FULL, properties: [PROP_A] }
  const sm = buildPropertyModels(single, buildDerived(single, TODAY), groupPhotos(FULL.photos))
  check('single: ONE unified model holding everything', sm.length === 1 && sm[0].upcoming.length === 2 && sm[0].completed.length === 2)
}

// ── trust facts + presets ───────────────────────────────────────────────────
console.log('\nTrust facts + recommendations honesty:')
check('customerSince = earliest provable year', customerSinceYear(FULL) === '2026')
check('customerSince null when nothing exists', customerSinceYear({ ...FULL, jobs: [], quotes: [], invoices: [] }) === null)
{
  const presets = requestPresetsOf(FULL)
  check('presets come from the owner catalogue only', presets.length === 1 && presets[0] === 'Mowing')
  check('blank names filtered, cap respected', presets.length <= MAX_REQUEST_PRESETS)
}

// ── the assembled view ──────────────────────────────────────────────────────
console.log('\nbuildPortalView:')
{
  const view = buildPortalView(FULL, TODAY, renderers)
  check('firstName extracted', view.firstName === 'Jordan')
  check('multiProperty true with 2 properties', view.multiProperty === true)
  check('docItems prebuilt (7)', view.docItems.length === 7)
  check('propertyModels present', view.propertyModels.length >= 2)
  check('money strip matches the ledger view', Math.abs(view.money.due - derived.outstanding) < 0.01)
  // The loose 'other' photo (p3) has no job → orphan; the completed-visit
  // before/after pair is shown on the card, not here.
  check('view.orphanPhotos carries the loose photo only', view.orphanPhotos.length === 1 && view.orphanPhotos[0].id === 'p3')
}

// ── deep links (URL-addressable portal) ─────────────────────────────────────
console.log('\nparsePortalDeepLink (the URL names a place, honestly):')
{
  check('?tab=billing → billing tab', parsePortalDeepLink('?tab=billing').tab === 'billing')
  check('?tab=visits → visits tab', parsePortalDeepLink('?tab=visits').tab === 'visits')
  check('unknown tab → null (falls back to Home)', parsePortalDeepLink('?tab=nonsense').tab === null)
  check('empty search → all null', (() => { const l = parsePortalDeepLink(''); return l.tab === null && l.docsCat === null && l.focusDocId === null })())
  const inv = parsePortalDeepLink('?invoice=abc-123')
  check('?invoice= → billing + invoice filter + focus id', inv.tab === 'billing' && inv.docsCat === 'invoice' && inv.focusDocId === 'abc-123')
  const quo = parsePortalDeepLink('?quote=q-9')
  check('?quote= → billing + quote filter + focus id', quo.tab === 'billing' && quo.docsCat === 'quote' && quo.focusDocId === 'q-9')
  check('?invoice wins over a conflicting ?tab', parsePortalDeepLink('?tab=visits&invoice=x').tab === 'billing')
  check('a document id is a one-shot focus, never a data claim (any string passes through)', parsePortalDeepLink('?invoice=ghost').focusDocId === 'ghost')
  check('empty ?invoice= value is ignored', parsePortalDeepLink('?invoice=').focusDocId === null)
  check('?tab=billing&cat=quote → quote filter, no focus', (() => { const l = parsePortalDeepLink('?tab=billing&cat=quote'); return l.docsCat === 'quote' && l.focusDocId === null })())
  check('?tab=home → home (persisted form drops the param)', parsePortalDeepLink('?tab=home').tab === 'home')
  check('leading "?" optional', parsePortalDeepLink('tab=billing').tab === 'billing')
}

// ── tablist keyboard model (accessible tab bar) ─────────────────────────────
console.log('\ntabNavTarget (arrow-key tab navigation — the ring must not trap):')
{
  const N = 6
  check('ArrowRight advances', tabNavTarget('ArrowRight', 0, N) === 1)
  check('ArrowRight wraps last → first', tabNavTarget('ArrowRight', N - 1, N) === 0)
  check('ArrowLeft retreats', tabNavTarget('ArrowLeft', 2, N) === 1)
  check('ArrowLeft wraps first → last', tabNavTarget('ArrowLeft', 0, N) === N - 1)
  check('ArrowDown == ArrowRight, ArrowUp == ArrowLeft', tabNavTarget('ArrowDown', 0, N) === 1 && tabNavTarget('ArrowUp', 0, N) === N - 1)
  check('Home → first, End → last', tabNavTarget('Home', 3, N) === 0 && tabNavTarget('End', 3, N) === N - 1)
  check('an unrelated key is left alone (null)', tabNavTarget('Enter', 0, N) === null && tabNavTarget('a', 0, N) === null)
  check('single-tab bar: arrows stay put (no wrap glitch)', tabNavTarget('ArrowRight', 0, 1) === 0 && tabNavTarget('ArrowLeft', 0, 1) === 0)
  check('empty bar → null (no crash)', tabNavTarget('ArrowRight', 0, 0) === null)
  check('never returns an out-of-range index', [0, 1, 5].every(c => ['ArrowRight', 'ArrowLeft', 'Home', 'End'].every(k => { const r = tabNavTarget(k, c, N); return r === null || (r >= 0 && r < N) })))
}

// ── Add to calendar (.ics generation) ───────────────────────────────────────
console.log('\nbuildVisitICS / visitToCalendarEvent (a malformed .ics silently fails to import):')
{
  const STAMP = '2026-07-18T15:04:05.000Z'
  const ics = buildVisitICS([{ uid: 'visit-j1@edgequote', dateISO: '2026-07-20', title: 'Lawn Mowing - Edge Co', description: 'Your scheduled visit with Edge Co.', location: '12 Main St SW' }], { stampISO: STAMP, calName: 'Edge Co visits' })
  check('wrapped in VCALENDAR', ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'))
  check('declares VERSION 2.0 + a PRODID', ics.includes('VERSION:2.0') && ics.includes('PRODID:'))
  check('one VEVENT with a stable UID', (ics.match(/BEGIN:VEVENT/g) || []).length === 1 && ics.includes('UID:visit-j1@edgequote'))
  check('all-day DTSTART on the scheduled date', ics.includes('DTSTART;VALUE=DATE:20260720'))
  check('all-day DTEND is the NEXT day (exclusive end)', ics.includes('DTEND;VALUE=DATE:20260721'))
  check('DTSTAMP is basic-UTC from the injected instant', ics.includes('DTSTAMP:20260718T150405Z'))
  check('SUMMARY / LOCATION carried', ics.includes('SUMMARY:Lawn Mowing - Edge Co') && ics.includes('LOCATION:12 Main St SW'))
  check('CRLF line endings (RFC 5545)', ics.includes('\r\n') && !/[^\r]\n/.test(ics))
  check('X-WR-CALNAME set from calName', ics.includes('X-WR-CALNAME:Edge Co visits'))
  // Escaping — a comma/semicolon/backslash in a title must not break the parser.
  const esc = buildVisitICS([{ uid: 'u', dateISO: '2026-01-01', title: 'Mow, trim; edge \\ blow' }], { stampISO: STAMP })
  check('text escaping per RFC 5545 (, ; \\)', esc.includes('SUMMARY:Mow\\, trim\\; edge \\\\ blow'))
  check('year boundary: Dec 31 → DTEND Jan 1 next year', buildVisitICS([{ uid: 'u', dateISO: '2026-12-31', title: 'x' }], { stampISO: STAMP }).includes('DTEND;VALUE=DATE:20270101'))
  const multi = buildVisitICS([{ uid: 'a', dateISO: '2026-07-20', title: 'A' }, { uid: 'b', dateISO: '2026-07-27', title: 'B' }], { stampISO: STAMP })
  check('multiple visits → multiple VEVENTs', (multi.match(/BEGIN:VEVENT/g) || []).length === 2)
  check('no visits → valid but empty VCALENDAR', (() => { const e = buildVisitICS([], { stampISO: STAMP }); return e.includes('BEGIN:VCALENDAR') && !e.includes('BEGIN:VEVENT') })())

  // Mapper: honest title + the visit's OWN property, stable uid.
  const propsById = new Map([[PROP_A.id, PROP_A]])
  const ev = visitToCalendarEvent(job({ id: 'jz', service_type: 'Aeration', property_id: PROP_A.id, scheduled_date: '2026-08-01' }), FULL.business, propsById)
  check('mapper: title includes the business', ev.title === 'Aeration - Edge Co')
  check('mapper: location is the visit’s OWN property address', ev.location === PROP_A.address)
  check('mapper: uid is stable per job', ev.uid === 'visit-jz@edgequote')
  check('mapper: unknown property → no location (never the primary as a stand-in)', visitToCalendarEvent(job({ id: 'jn', property_id: 'ghost' }), FULL.business, propsById).location === null)
}

// ── "Ask about this" composer prefill ───────────────────────────────────────
console.log('\nmessageAboutDoc (the owner must know WHICH document):')
{
  const p = messageAboutDoc('Invoice', 'INV-2088', 'Lawn Mowing')
  check('carries the document number (the load-bearing part)', p.includes('INV-2088'))
  check('kind is lower-cased in prose', p.startsWith('About invoice '))
  check('title parenthesized when present', p.includes('(Lawn Mowing)'))
  check('ends with ": " so the cursor lands where they type', p.endsWith(': '))
  check('exact shape', p === 'About invoice INV-2088 (Lawn Mowing): ')
  check('no title → number only, still ends ready to type', messageAboutDoc('Quote', 'Q-14') === 'About quote Q-14: ')
  check('blank title is dropped, not rendered as ()', messageAboutDoc('Quote', 'Q-14', '   ') === 'About quote Q-14: ')
}

// ── primaryPortalAction (your next thing, surfaced from any tab) ─────────────
console.log('\nprimaryPortalAction (honest priority; never nags about nothing):')
{
  const props = FULL.properties!
  const B = FULL.business
  // Run the REAL engines the banner uses, so the test catches an integration drift.
  const act = (invoices: typeof FULL.invoices, quotes: typeof FULL.quotes = []) =>
    primaryPortalAction(buildDocItems({ quotes, invoices, properties: props, business: B, todayISO: TODAY, renderers }), moneySummary(invoices, B))
  const iDue = FULL.invoices.find(i => i.id === 'i-due')!    // unpaid, due 2026-07-26 (future) → due, not overdue
  const iLate = FULL.invoices.find(i => i.id === 'i-late')!  // partial, due 2026-07-01 (past) → overdue
  const iDraft = FULL.invoices.find(i => i.id === 'i-draft')!
  const iPaid = FULL.invoices.find(i => i.id === 'i-paid')!
  const qSent = FULL.quotes.find(q => q.id === 'q-sent')!

  const overdue = act([iLate])
  check('overdue invoice → pay, "Past due" headline', overdue?.kind === 'pay' && overdue.headline.startsWith('Past due:'))
  check('single owing invoice → focus that invoice', overdue?.focusDocId === 'i-late')
  check('due-not-overdue → pay, "Balance due" headline', act([iDue])?.headline.startsWith('Balance due:') === true)
  check('overdue outranks a waiting quote', act([iLate], [qSent])?.headline.startsWith('Past due:') === true)
  check('a balance outranks a waiting quote', act([iDue], [qSent])?.kind === 'pay')
  const quoteOnly = act([], [qSent])
  check('only a quote waiting → approve, focus the quote', quoteOnly?.kind === 'approve' && quoteOnly.docsCat === 'quote' && quoteOnly.focusDocId === 'q-sent')
  check('several owing → land on the list, no single focus', act([iDue, iLate])?.focusDocId === null)
  check('all paid, nothing waiting → null (banner never renders)', act([iPaid]) === null)
  check('a draft invoice is never "owing"', act([iDraft]) === null)
  check('key is stable for identical input (a dismissal sticks)', act([iLate])?.key === act([iLate])?.key)
  check('key changes when the situation does (banner returns for the new thing)', act([iLate])?.key !== act([], [qSent])?.key)
}

// ── draftStorageKey (a composer draft that survives tapping away) ────────────
console.log('\ndraftStorageKey (token-scoped, collision-free):')
{
  const tok = 'jordan-EQ5SEXHP'
  check('carries the token (a draft is scoped to its customer)', draftStorageKey(tok, 'message').includes(tok))
  check('names the surface', draftStorageKey(tok, 'message').includes('message') && draftStorageKey(tok, 'request').includes('request'))
  check('the two composers never share a key', draftStorageKey(tok, 'message') !== draftStorageKey(tok, 'request'))
  check('different tokens → different keys (no cross-customer draft)', draftStorageKey('a', 'message') !== draftStorageKey('b', 'message'))
  check('stable for identical input', draftStorageKey(tok, 'request') === draftStorageKey(tok, 'request'))
  check('namespaced so it can never collide with another app key', draftStorageKey(tok, 'message').startsWith('eqp:draft:'))
}

// ── etransferReference (the memo to copy — never an ambiguous one) ──────────
console.log('\netransferReference (one-tap e-transfer memo; never a wrong ref):')
{
  const props = FULL.properties!
  const B = FULL.business
  const ref = (invoices: typeof FULL.invoices) =>
    etransferReference(buildDocItems({ quotes: [], invoices, properties: props, business: B, todayISO: TODAY, renderers }))
  const iDue = FULL.invoices.find(i => i.id === 'i-due')!    // unpaid, balance 105
  const iLate = FULL.invoices.find(i => i.id === 'i-late')!  // partial, balance 110
  const iDraft = FULL.invoices.find(i => i.id === 'i-draft')!
  const iPaid = FULL.invoices.find(i => i.id === 'i-paid')!
  check('exactly one owing invoice → its number', ref([iDue]) === 'INV-1')
  check('several owing → null (ambiguous; keep the plain guidance)', ref([iDue, iLate]) === null)
  check('nothing owing → null', ref([iPaid]) === null)
  check('a draft invoice is never a reference', ref([iDraft]) === null)
  check('a cancelled invoice is never a reference', ref([{ ...iDue, id: 'i-x', status: 'cancelled' }]) === null)
  check('quotes are ignored entirely', etransferReference(buildDocItems({ quotes: FULL.quotes, invoices: [], properties: props, business: B, todayISO: TODAY, renderers })) === null)
}

// ── isSendChord (Cmd/Ctrl+Enter to send; plain Enter stays a newline) ───────
console.log('\nisSendChord (a phone keyboard, which sends no modifier, must never fire it):')
{
  check('Cmd+Enter sends', isSendChord({ key: 'Enter', metaKey: true }))
  check('Ctrl+Enter sends', isSendChord({ key: 'Enter', ctrlKey: true }))
  check('plain Enter does NOT send (stays a newline)', !isSendChord({ key: 'Enter' }))
  check('Shift+Enter does NOT send', !isSendChord({ key: 'Enter', shiftKey: true } as { key: string; metaKey?: boolean; ctrlKey?: boolean }))
  check('Cmd without Enter does NOT send', !isSendChord({ key: 'a', metaKey: true }))
  check('Cmd+Shift+Enter still sends (shift is irrelevant)', isSendChord({ key: 'Enter', metaKey: true, ctrlKey: false }))
}

// ── dueSoonLabel (surface an imminent due date; never nag beyond the window) ─
console.log('\ndueSoonLabel (so "due tomorrow" never reads like "due next month"):')
{
  const T = '2026-07-18'
  check('due today → urgent', JSON.stringify(dueSoonLabel('2026-07-18', T)) === JSON.stringify({ rel: 'due today', urgent: true }))
  check('due tomorrow → urgent', JSON.stringify(dueSoonLabel('2026-07-19', T)) === JSON.stringify({ rel: 'due tomorrow', urgent: true }))
  check('due in 5 days → shown, NOT urgent', JSON.stringify(dueSoonLabel('2026-07-23', T)) === JSON.stringify({ rel: 'due in 5 days', urgent: false }))
  check('due in exactly 7 days → still shown', dueSoonLabel('2026-07-25', T)?.rel === 'due in 7 days')
  check('due in 8 days → null (date alone carries it)', dueSoonLabel('2026-07-26', T) === null)
  check('due next month → null', dueSoonLabel('2026-08-30', T) === null)
  check('past due → null (overdue has its own louder treatment)', dueSoonLabel('2026-07-10', T) === null)
  check('only today/tomorrow are urgent', dueSoonLabel('2026-07-20', T)?.urgent === false && dueSoonLabel('2026-07-19', T)?.urgent === true)
}

// ── invoicePaymentNote (a partial bill states what's OWED, not just the total) ─
console.log('\ninvoicePaymentNote (never mistakes the total for what is owed):')
{
  const d = new Map(buildDocItems({ quotes: FULL.quotes, invoices: FULL.invoices, properties: FULL.properties!, business: FULL.business, todayISO: TODAY, renderers }).map(x => [x.rawId, x]))
  const late = d.get('i-late')!   // total 210, paid 100, balance 110 (partial)
  const dueDoc = d.get('i-due')!  // total 105, paid 0, balance 105 (full unpaid)
  const paid = d.get('i-paid')!   // settled
  const pn = invoicePaymentNote(late)
  check('partial → still-due is the BALANCE, not the total', pn?.due === '$110.00')
  check('partial → paid is total minus balance', pn?.paid === '$100.00')
  check('full-unpaid invoice → null (its total IS what is due)', invoicePaymentNote(dueDoc) === null)
  check('settled invoice → null', invoicePaymentNote(paid) === null)
  check('a quote is never a payment note', invoicePaymentNote(d.get('q-sent')!) === null)
}

// ── which contact detail is missing (the prompt's ONE input) ─────────────────
// This replaced needsContactMethod(), which only answered the both-missing case
// and so never asked the 47 customers with a phone and no email — the commonest
// gap in the book.
console.log('\ncontactGap (what the portal asks for, and when it says nothing):')
{
  check('neither on file → both', contactGap({ phone: null, email: null }) === 'both')
  check('empty strings count as missing', contactGap({ phone: '', email: '' }) === 'both')
  check('whitespace is not a contact detail', contactGap({ phone: '  ', email: ' ' }) === 'both')
  check('phone on file, no email → asks for the email', contactGap({ phone: '403-555-0100', email: null }) === 'email')
  check('email on file, no phone → asks for the phone', contactGap({ phone: null, email: 'j@x.com' }) === 'phone')
  check('complete file → asks for nothing', contactGap({ phone: '403-555-0100', email: 'j@x.com' }) === 'none')
  check('whitespace phone with a real email still asks for the phone', contactGap({ phone: '   ', email: 'j@x.com' }) === 'phone')
  // ⚠️ THE honesty case. A payload we failed to read tells us nothing about the
  // file — so the prompt asks for nothing rather than asserting a gap. The
  // inverse ("failed read ⇒ profile complete") is equally covered: the only
  // thing gated on this is the prompt, and it returns on the next good load.
  check('missing customer payload claims no gap', contactGap(null) === 'none' && contactGap(undefined) === 'none')
}

// ── the client-side mirror of portal_add_contact's validation ────────────────
// The RPC is the authority and re-checks everything; these exist so an obvious
// typo doesn't cost a round-trip. verify:portal-contact pins them against the
// migration so the two can't drift apart silently.
console.log('\nisUsablePhone / isUsableEmail (instant feedback, server still decides):')
{
  check('a full national number is usable', isUsablePhone('(403) 555-0100'))
  check('punctuation and spacing are irrelevant', isUsablePhone('403.555.0100') && isUsablePhone('4035550100'))
  check('a country code is fine', isUsablePhone('+1 403 555 0100'))
  // 7 digits is what phoneMatches() will LINK on, deliberately not what this will
  // accept: a local number with no area code cannot be dialled by the business.
  check('a 7-digit local number is refused', !isUsablePhone('555-0100'))
  check(`the floor is ${PHONE_MIN_DIGITS} digits`, !isUsablePhone('4035550') && isUsablePhone('4035550100'))
  check('an absurdly long number is refused', !isUsablePhone('1234567890123456789'))
  check('empty is not usable', !isUsablePhone('') && !isUsablePhone('   '))

  check('an ordinary address is usable', isUsableEmail('jane@example.com'))
  check('surrounding whitespace is tolerated', isUsableEmail('  jane@example.com '))
  check('no @ is refused', !isUsableEmail('jane.example.com'))
  check('no TLD is refused', !isUsableEmail('jane@example'))
  check('a space inside is refused', !isUsableEmail('jane doe@example.com'))
  check('empty is refused', !isUsableEmail('') && !isUsableEmail('  '))
}

// ── doc filters: finding tools only when there's something to find ──────────
// A search box + sort toggle + count + category pills over a two-item list is
// furniture. Measured on the live book: 46 portal customers, 2.2 documents on
// average, 45 of them holding five or fewer. The threshold is what keeps the
// controls from greeting almost everyone; pin it so a refactor can't quietly
// re-show them (or, worse, hide them from the one customer who has a real list).
{
  check('an empty list needs no finding tools', showDocFilters(0) === false)
  check('a single document needs no finding tools', showDocFilters(1) === false)
  check('the typical portal (2-3 docs) shows no filters', showDocFilters(2) === false && showDocFilters(3) === false)
  check('five documents — still scannable, still no filters', showDocFilters(5) === false)
  check('at the threshold the filters appear', showDocFilters(DOC_FILTER_MIN) === true)
  check('a long list keeps them', showDocFilters(25) === true)
  check('the threshold is the documented 6', DOC_FILTER_MIN === 6, String(DOC_FILTER_MIN))
}

// ── post-checkout confirmation (the ledger answers, never the URL) ────────────
// The banner that tells a customer their money arrived. It must say yes ONLY on
// evidence in the ledger, and it must not miss the common ordering where the
// webhook lands before the page does (the old row-count test could never see it).
console.log('\nrecentPaymentLanded (post-checkout confirmation):')
{
  const NOW = Date.parse('2026-07-28T18:00:00Z')
  const pay = (over: Partial<Parameters<typeof recentPaymentLanded>[0] extends (infer P)[] | null | undefined ? P : never>) => ({
    id: 'p1', amount: 100, status: 'paid', paid_at: '2026-07-28T17:59:00Z', provider: 'stripe',
    invoice_id: 'inv-1', created_at: '2026-07-28T17:59:00Z', kind: 'payment', ...over,
  })

  check('a payment stamped a minute ago → confirmed', recentPaymentLanded([pay({})], NOW) === true)
  check('nothing in the ledger → never confirmed', recentPaymentLanded([], NOW) === false)
  check('null/undefined payload claims nothing', recentPaymentLanded(null, NOW) === false && recentPaymentLanded(undefined, NOW) === false)
  // The whole point of the fix: the webhook beat the page, so the row is ALREADY
  // in the first payload. A count-delta can never see it; recency can.
  check('a row already present at first paint still confirms', recentPaymentLanded([pay({ paid_at: '2026-07-28T17:58:30Z' })], NOW) === true)
  // …and the honesty half: an OLD payment is somebody else's earlier story.
  check('last month’s payment does NOT confirm today’s checkout', recentPaymentLanded([pay({ paid_at: '2026-06-20T10:00:00Z', created_at: '2026-06-20T10:00:00Z' })], NOW) === false)
  check('a payment just outside the window does not confirm', recentPaymentLanded([pay({ paid_at: '2026-07-28T17:44:00Z', created_at: '2026-07-28T17:44:00Z' })], NOW, 15 * 60 * 1000) === false)
  check('an unpaid/pending row is not money', recentPaymentLanded([pay({ status: 'pending' })], NOW) === false)
  check('a refund is not a payment', recentPaymentLanded([pay({ kind: 'refund' })], NOW) === false)
  check('a legacy row with no kind still counts as a payment', recentPaymentLanded([pay({ kind: undefined })], NOW) === true)
  // Provider-agnostic on purpose: portal checkout records 'stripe', the saved-card
  // path 'card', and a future provider must not silently stop confirming.
  check('provider-agnostic (card path confirms too)', recentPaymentLanded([pay({ provider: 'card' })], NOW) === true)
  check('falls back to created_at when paid_at is null', recentPaymentLanded([pay({ paid_at: null })], NOW) === true)
  check('an unparseable stamp is ignored, not trusted', recentPaymentLanded([pay({ paid_at: 'not-a-date', created_at: '' })], NOW) === false)
  check('one recent payment among old ones still confirms', recentPaymentLanded([pay({ id: 'old', paid_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }), pay({})], NOW) === true)
}

// ═══════════════════════════════════════════════════════════════════════════
// Invoice ACCESS — see it, open it, download it, and read the right number.
//
// A customer who cannot open their bill does not pay it, so this is a collections
// path, not a convenience. The bug that closed it was invisible to tsc and to
// every check above: the PDF logo. @react-pdf embeds whatever bytes `src`
// resolves to, at full resolution, and the live branding logo is a 6144 × 4096
// PNG weighing 10.8 MB — so every invoice PDF came out at 11.3 MB. On a phone
// that is a stalled spinner or "Could not generate the PDF"; the invoice was
// listed, priced and payable, and simply could not be opened.
//
// pdfLogoUrl is the bound. These checks pin it, plus the surrounding contract:
// which invoices are the customer's, what each owes, and that an empty book is
// distinguishable from a failed load.
{
  const view = buildPortalView(FULL, TODAY, renderers)
  const invs = view.docItems.filter(d => d.kind === 'invoice')
  const byNum = new Map(invs.map(d => [d.number, d]))

  // 1. The authorized customer sees exactly their own non-draft invoices.
  check('customer sees every issued invoice', invs.length === 3, `saw ${invs.length}`)
  check('… and they are the payload\'s own invoices', invs.every(d => FULL.invoices.some(i => i.id === d.rawId)))
  check('a DRAFT invoice is never shown (owner\'s unfinished work)', !byNum.has('INV-3'))

  // 2. Nothing from another customer can appear. get_portal_data is token-scoped,
  //    so the payload IS the authorization boundary — this pins that the model
  //    never reaches beyond the payload it was handed.
  const OTHER: PortalData = { ...FULL, customer: { ...FULL.customer, id: 'c2', name: 'Someone Else' },
    invoices: [{ ...FULL.invoices[0], id: 'i-theirs', invoice_number: 'INV-999', amount: 999 }] }
  const otherIds = new Set(buildPortalView(OTHER, TODAY, renderers).docItems.filter(d => d.kind === 'invoice').map(d => d.rawId))
  check('another customer\'s invoice never leaks into this portal', invs.every(d => !otherIds.has(d.rawId)))
  check('… and their own list is not empty either (the check can fail)', otherIds.size === 1 && otherIds.has('i-theirs'))

  // 3 + 4. View and Download are both `getBlob()` + `filename` on the DocItem —
  //        the only contract DocActions has. A missing/blank filename downloads
  //        as "download" with no extension, which reads as a broken file.
  const due = byNum.get('INV-1')!
  check('View/Download has a document to fetch', typeof due.getBlob === 'function')
  check('the PDF downloads under the invoice number', due.filename === 'INV-1.pdf', due.filename)
  check('every invoice row can produce a document', invs.every(d => typeof d.getBlob === 'function' && /^INV-\d+\.pdf$/.test(d.filename)))

  // 5. Paid / partially paid / unpaid stay accurate — GST 5% on the fixture.
  check('unpaid: balance is the full GST-inclusive total', due.amount === 105 && due.balance === 105, `${due.amount}/${due.balance}`)
  const late = byNum.get('INV-2')!
  check('partially paid: balance is what is STILL owed', late.amount === 210 && late.balance === 110, `${late.amount}/${late.balance}`)
  check('… and the row says due-vs-paid, not just the total', JSON.stringify(invoicePaymentNote(late)) === JSON.stringify({ due: '$110.00', paid: '$100.00' }))
  check('past its due date, an owing invoice reads overdue', late.status === 'overdue')
  const paid = byNum.get('INV-4')!
  check('paid: balance is zero, never negative on an overpayment', paid.balance === 0 && paid.amount === 63)
  check('a paid invoice is not presented as payable', !(paid.balance > 0))
  // The portal must agree with the owner's screens to the cent — same engine.
  check('money strip matches the rows it summarizes',
    view.money.invoiced === 378 && view.money.paid === 163 && view.money.due === 215 && view.money.owingCount === 2,
    JSON.stringify(view.money))

  // 6. "We couldn't reach the server" must never render as "you have no invoices".
  //    null = the load failed (PortalClient keeps the data it already had); an
  //    EMPTY array is a real answer about a real customer. Two different states.
  check('a failed load is null — not an empty portal', normalizePortal(null) === null)
  const emptyBook = normalizePortal({ ...FULL, invoices: [] })
  check('a customer with no invoices is an empty list, not a failure',
    emptyBook !== null && Array.isArray(emptyBook.invoices) && emptyBook.invoices.length === 0)
  check('… and that empty book renders zero invoice rows',
    buildPortalView(emptyBook!, TODAY, renderers).docItems.filter(d => d.kind === 'invoice').length === 0)

  // 7. THE root-cause guard. A logo the page draws at ≤200×105pt must not be
  //    embedded at 6144px. Owner PDFs use the identical helper, so this pins both.
  const LOGO = 'https://x.supabase.co/storage/v1/object/public/branding/u1/logo.png?t=1782204636636'
  const sized = pdfLogoUrl(LOGO)
  check('the PDF logo goes through the resizing endpoint', sized.includes('/storage/v1/render/image/public/'))
  check('… bounded to PDF_LOGO_MAX_PX', sized.includes(`width=${PDF_LOGO_MAX_PX}`) && sized.includes(`height=${PDF_LOGO_MAX_PX}`))
  // `cover` would CROP the logo — a mutilated brand on every document.
  check('… fitted, never cropped', sized.includes('resize=contain') && !sized.includes('resize=cover'))
  // The logo lives at ONE fixed path and is overwritten in place, so losing the
  // cache-buster pins every future PDF to the old logo.
  check('… and the cache-buster survives (logo.png is overwritten in place)', sized.includes('t=1782204636636'))
  // 7b. Owner behaviour is unchanged for anything this helper can't resize.
  check('a non-storage logo URL is passed through untouched', pdfLogoUrl('https://cdn.example.com/logo.png') === 'https://cdn.example.com/logo.png')
  check('a data: URI logo is passed through untouched', pdfLogoUrl('data:image/png;base64,AAAA') === 'data:image/png;base64,AAAA')
  check('no logo stays no logo (never the string "null")', pdfLogoUrl(null) === '' && pdfLogoUrl(undefined) === '')
}

// 8. Deposits — the portal must quote EXACTLY what the charge routes collect.
//    Every figure below flows from lib/payments/deposit (THE engine both
//    /api/portal/pay and /api/payments/checkout call); these checks pin that the
//    row, the button, the banner and Stripe can never name different money.
{
  const depInvoice = (over: Record<string, unknown>) => ({
    id: 'i-dep', invoice_number: 'INV-9', service_type: 'Fence build', amount: 4000,
    status: 'unpaid', issued_date: '2026-07-12', due_date: '2026-07-25', notes: null, address: null,
    property_id: PROP_A.id, line_items: null, job_id: null, created_at: '2026-07-12T10:00:00Z',
    discount_type: null, discount_value: null, amount_paid: 0,
    deposit_amount: 2100, deposit_requested_at: '2026-07-12T11:00:00Z', ...over,
  })
  // GST-free business so the $4,000/50% example reads exactly as the spec's.
  const noGst = { ...FULL.business!, gst_percent: 0 }
  const viewOf = (inv: Record<string, unknown>) =>
    buildPortalView(normalizePortal({ ...FULL, business: noGst, quotes: [], invoices: [inv] })!, TODAY, renderers)

  // 8a. The round-trip tripwire — the payload keys must survive normalize (the
  //     services bug shipped exactly this way).
  const norm = normalizePortal({ ...FULL, invoices: [depInvoice({})] })!
  check('deposit payload keys survive normalizePortal',
    Number(norm.invoices[0].deposit_amount) === 2100 && norm.invoices[0].deposit_requested_at === '2026-07-12T11:00:00Z')

  // 8b. The $4,000 / 50% walk from the owner's own example.
  const v = viewOf(depInvoice({ deposit_amount: 2000 }))
  const row = v.docItems.find(d => d.number === 'INV-9')!
  check('deposit outstanding: the button collects the deposit, not the total',
    row.payAmount === 2000 && row.payIsDeposit === true, `payAmount=${row.payAmount}`)
  check('… while the row still knows total and full balance', row.amount === 4000 && row.balance === 4000)
  check('… and the deposit picture is the engine’s', JSON.stringify(row.deposit) ===
    JSON.stringify({ requested: 2000, percent: 50, outstanding: 2000, remainingAfter: 2000, covered: false }))
  const note = invoiceDepositNote(row)!
  check('the ask reads: due now / % / of total / after',
    JSON.stringify(note) === JSON.stringify({ dueNow: '$2,000.00', percentLabel: '50% deposit', ofTotal: '$4,000.00', after: '$2,000.00', paidSoFar: null }),
    JSON.stringify(note))
  check('no deposit-paid claim while it is still owed', invoiceDepositPaidNote(row) === null)
  const act = primaryPortalAction(v.docItems, v.money)!
  check('the banner asks for the deposit — never "Past due: $4,000" over a $2,000 ask',
    act.headline === 'Deposit due: $2,000.00' && act.focusDocId === 'i-dep', act.headline)

  // 8c. A request saved but NOT yet sent still gates the portal (the charge rule
  //     already honours it — hiding it would recreate the display/charge split).
  const draftReq = viewOf(depInvoice({ deposit_amount: 2000, deposit_requested_at: null })).docItems.find(d => d.number === 'INV-9')!
  check('an unsent request still quotes the deposit (display mirrors the charge rule)',
    draftReq.payAmount === 2000 && draftReq.payIsDeposit === true)

  // 8d. After the webhook's payment row lands: deposit covered, remainder open.
  const paidV = viewOf(depInvoice({ deposit_amount: 2000, amount_paid: 2000, status: 'partial' }))
  const paidRow = paidV.docItems.find(d => d.number === 'INV-9')!
  check('deposit paid: the button now collects the REMAINDER, unlabelled',
    paidRow.payAmount === 2000 && paidRow.payIsDeposit === false && paidRow.balance === 2000)
  check('… the ask note is gone (no second prompt to pay the deposit)', invoiceDepositNote(paidRow) === null)
  check('… and the paid pair is exactly "Deposit paid $2,000 · $2,000 remaining"',
    JSON.stringify(invoiceDepositPaidNote(paidRow)) === JSON.stringify({ paid: '$2,000.00', remaining: '$2,000.00' }))
  check('… the banner returns to the ordinary balance',
    primaryPortalAction(paidV.docItems, paidV.money)!.headline === 'Balance due: $2,000.00')

  // 8e. Covered by ANY method — an e-transfer that covers the ask satisfies it.
  const partly = viewOf(depInvoice({ deposit_amount: 1000, amount_paid: 1500, status: 'partial' })).docItems.find(d => d.number === 'INV-9')!
  check('a deposit covered by other payments never re-asks', partly.payIsDeposit === false && partly.payAmount === 2500)

  // 8f. Invoice edited DOWN below the request: the ask clamps to the live
  //     balance (the engine's rule) and the copy quotes the CLAMPED figure.
  const clamped = viewOf(depInvoice({ amount: 1500, deposit_amount: 2000 })).docItems.find(d => d.number === 'INV-9')!
  check('an edited-down invoice can never ask for more than is owed',
    clamped.payAmount === 1500 && invoiceDepositNote(clamped)!.dueNow === '$1,500.00' && invoiceDepositNote(clamped)!.after === '$0.00')

  // 8g. Fully paid: nothing left to ask, no stale CTA.
  const settled = viewOf(depInvoice({ deposit_amount: 2000, amount_paid: 4000, status: 'paid' })).docItems.find(d => d.number === 'INV-9')!
  check('a settled invoice asks for nothing', settled.payAmount === 0 && settled.balance === 0 && invoiceDepositPaidNote(settled) === null)

  // 8h. A cancelled invoice with a leftover request asks for nothing.
  const cancelled = viewOf(depInvoice({ status: 'cancelled' })).docItems.find(d => d.number === 'INV-9')!
  check('a cancelled invoice with a leftover request asks for nothing',
    cancelled.payAmount === 0 && cancelled.payIsDeposit === false && cancelled.deposit === undefined)

  // 8i. GST-inclusive: with 5% GST a $4,000 invoice totals $4,200 — the stored
  //     deposit_amount is ALREADY the GST-inclusive figure the customer was told.
  const gstV = buildPortalView(normalizePortal({ ...FULL, quotes: [], invoices: [depInvoice({ deposit_amount: 2100 })] })!, TODAY, renderers)
  const gstRow = gstV.docItems.find(d => d.number === 'INV-9')!
  check('GST: the ask is the stored inclusive figure and percent derives from the inclusive total',
    gstRow.payAmount === 2100 && gstRow.deposit!.percent === 50 && gstRow.amount === 4200)

  // 8j. Ordinary invoices are untouched by all of this.
  const plain = viewOf(depInvoice({ deposit_amount: null, deposit_requested_at: null })).docItems.find(d => d.number === 'INV-9')!
  check('no deposit: payAmount is simply the balance', plain.payAmount === 4000 && plain.payIsDeposit === false && plain.deposit === undefined)

  // 8k. THE ADVERSARIAL-REVIEW PINS — each of these reproduces a confirmed
  //     defect from the review pass; every figure shown must describe the ask
  //     the button actually collects, and money already received must stay
  //     visible on the row.
  // The percent describes the STORED request, so the moment the ask diverges
  // (clamped, or shrunk by a part-payment) it must drop to the plain word —
  // never "133.3% deposit", never "50%" over a $1,500 headline.
  check('clamped ask: no percent claim (never "133.3% deposit")',
    invoiceDepositNote(clamped)!.percentLabel === 'Deposit', invoiceDepositNote(clamped)!.percentLabel)
  const partPaidAsk = viewOf(depInvoice({ deposit_amount: 2000, amount_paid: 500, status: 'partial' })).docItems.find(d => d.number === 'INV-9')!
  const ppNote = invoiceDepositNote(partPaidAsk)!
  check('part-paid ask: residual deposit, no stale percent, and the $500 stays visible',
    partPaidAsk.payAmount === 1500 && ppNote.percentLabel === 'Deposit' && ppNote.paidSoFar === '$500.00' && ppNote.after === '$2,000.00',
    JSON.stringify(ppNote))
  // Paid figures are ACTUAL money, not the requested figure — an overpay beyond
  // the ask must not vanish.
  const overAsk = viewOf(depInvoice({ deposit_amount: 2000, amount_paid: 2500, status: 'partial' })).docItems.find(d => d.number === 'INV-9')!
  check('deposit-paid pair quotes real money received, not the request',
    JSON.stringify(invoiceDepositPaidNote(overAsk)) === JSON.stringify({ paid: '$2,500.00', remaining: '$1,500.00' }))
}

// 9. Structural pins for the surfaces the pure suite can't execute — the same
//    defects, asserted over the real source so they cannot quietly return.
{
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  // 9a. The portal pay route must never answer a failed deposit read with "no
  //     deposit" — that charges the FULL balance behind a button that said
  //     "Pay $2,000 deposit" (the review's P1).
  const payRoute = read('src/app/api/portal/pay/route.ts')
  check('pay route branches on the deposit read error (a failed read is never an answer)',
    /error:\s*depErr/.test(payRoute) && /if\s*\(depErr\)\s*return/.test(payRoute))
  check('pay route refuses when the service role is unavailable rather than guessing the ask',
    /if\s*\(!url\s*\|\|\s*!svc\)/.test(payRoute))
  // 9b. Home's inline quick-pay quotes the engine's ask, never the raw balance.
  const homeTab = read('src/app/portal/[token]/components/HomeTab.tsx')
  check('Home quick-pay button quotes payAmount (the engine), not balance',
    homeTab.includes('Pay {formatCurrency(oneInvoice.payAmount)}') && !homeTab.includes('Pay {formatCurrency(oneInvoice.balance)}'))
  // 9c. The e-transfer "one owing invoice" rule excludes cancelled invoices
  //     (their DocItem balance is positive by construction).
  const paySection = read('src/app/portal/[token]/components/PaymentsSection.tsx')
  check('e-transfer owing filter excludes cancelled/draft invoices',
    /owingDocs = view\.docItems\.filter\([^)]*status !== 'cancelled'[^)]*\)/.test(paySection))
}

// 10. What a customer is TOLD about a bill follows the ledger, not the status
//     column — plus the surface contracts of the simplification pass.
{
  const invOf = (over: Record<string, unknown>) => ({
    id: 'i-x', invoice_number: 'INV-X', service_type: 'Mowing', amount: 100,
    status: 'unpaid', issued_date: '2026-07-12', due_date: '2026-07-26', notes: null,
    address: null, property_id: null, line_items: null, job_id: null,
    created_at: '2026-07-12T10:00:00Z', discount_type: null, discount_value: null,
    amount_paid: 0, ...over,
  })
  // No GST by default so "amount 100, paid 100" is exactly the live INV-0060
  // shape. The GST case gets its own check below — it is the one that proves the
  // overlay reads the ENGINE's inclusive total rather than the raw amount column.
  // Typed as the payload's own business shape — inferring it from the no-GST
  // literal makes `gst_percent: number`, which the real (nullable) business then
  // fails to satisfy. tsx runs it either way; `next build` is the one that says so.
  const noGstBiz: PortalData['business'] = { ...FULL.business!, gst_percent: 0 }
  const docOf = (over: Record<string, unknown>, business: PortalData['business'] = noGstBiz) => buildDocItems({
    quotes: [], invoices: [invOf(over)] as unknown as PortalData['invoices'],
    properties: [], business, todayISO: TODAY, renderers,
  })[0]

  // The live shape this fixed: INV-0060, stored 'unpaid', $100.00 of $100.00
  // received. Every balance-derived surface said nothing was owed while the pill
  // and the Home feed said "Due".
  const fullyReceived = docOf({ status: 'unpaid', amount_paid: 100 })
  check('a fully-received invoice never reads as owing, whatever the status column says',
    fullyReceived.status === 'paid' && fullyReceived.balance === 0)
  check('… and the overlay changes only the WORD — balance and the ask stay 0',
    fullyReceived.balance === 0 && fullyReceived.payAmount === 0 && fullyReceived.amount === 100)
  // A 'sent' invoice settled by e-transfer is the same shape.
  check('a settled-but-unsynced "sent" invoice reads Paid too',
    docOf({ status: 'sent', amount_paid: 100 }).status === 'paid')
  // Cancelled keeps its own word — a withdrawn charge must stay explainable.
  check('a cancelled invoice is never relabelled Paid by the overlay',
    docOf({ status: 'cancelled', amount_paid: 100 }).status === 'cancelled')
  check('a cancelled UNPAID invoice still reads cancelled, not Due',
    docOf({ status: 'cancelled', amount_paid: 0 }).status === 'cancelled')
  // 'overpaid' is the more specific truth and outranks a generic "paid".
  check('an overpaid invoice keeps the more specific word',
    docOf({ status: 'overpaid', amount_paid: 130 }).status === 'overpaid')
  // The two overlays are mutually exclusive by construction (one needs balance
  // > 0, the other <= 0) — an unpaid, past-due bill must still shout.
  check('the settled overlay cannot mask an overdue bill',
    docOf({ status: 'unpaid', amount_paid: 0, due_date: '2026-07-01' }).status === 'overdue')
  check('a part-paid past-due bill is still overdue',
    docOf({ status: 'partial', amount_paid: 40, due_date: '2026-07-01' }).status === 'overdue')
  // The overlay asks the balance ENGINE, which works on the GST-inclusive total.
  // Paying the pre-tax figure does NOT settle a taxed bill — reading the raw
  // `amount` column here would tell a customer they were square while $5 stood.
  const taxed = docOf({ status: 'unpaid', amount_paid: 100 }, FULL.business!)
  check('paying the pre-tax amount does not settle a GST invoice',
    taxed.amount === 105 && taxed.balance === 5 && taxed.status === 'unpaid')

  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const homeTab = read('src/app/portal/[token]/components/HomeTab.tsx')
  const billingTab = read('src/app/portal/[token]/components/BillingTab.tsx')
  const paySection = read('src/app/portal/[token]/components/PaymentsSection.tsx')

  // 10a. Home's amount-due banner explains what the figure is the REST of, using
  //      the SAME pinned helpers the Billing row uses — never fresh arithmetic.
  //      Without it a part-paid customer met "Amount due · $347.50" and
  //      "Payment received · $347.50" on one page with nothing linking them.
  check('Home\'s due banner sources its paid-context from the pinned helpers',
    homeTab.includes('invoiceDepositPaidNote(oneInvoice)') && homeTab.includes('invoicePaymentNote(oneInvoice)'))
  // 10b. Payment INSTRUCTIONS only while there is something to pay.
  check('Ways-to-pay renders only when a bill is actually owed',
    paySection.includes('const hasSomethingToPay = owingDocs.length > 0') && paySection.includes('{hasSomethingToPay && ('))
  // 10c. The plan's exit verbs (including a red "Cancel plan") stay behind one
  //      disclosure — they must not greet a customer whose plan is running fine.
  check('plan change/pause/cancel sit behind a disclosure, not on the home screen',
    homeTab.includes('Change or pause this plan') && /<summary[^>]*>\s*\n?\s*Change or pause this plan/.test(homeTab))
  // 10d. A document row's title says what the document is FOR — clipping it to
  //      "Weed removal dep…" beside a money figure is a bill you can't identify.
  check('a Billing row title is not truncated',
    billingTab.includes('text-sm font-semibold text-ink tracking-tight">{d.title}')
    && !billingTab.includes('text-ink truncate tracking-tight">{d.title}'))
  // 10e. The payment row's amount must not share the truncating line — that was
  //      always the part that got cut ("Payment received · E-transfer · $7…").
  check('Home payment rows keep the amount off the truncating title line',
    homeTab.includes('{formatCurrency(p.amount)} · {formatDate(p.at)}')
    && !/truncate[^>]*>\s*\n?\s*\{p\.label\}\s*\n?\s*\{formatCurrency/.test(homeTab))
}

// 11. Home is not a history ledger — "Recent activity" narrowed to money that
//     actually MOVED. These pin both halves: what the surface may contain, and
//     what must never vanish from Home because of that narrowing.
{
  const pay = (over: Record<string, unknown>) => ({
    id: 'pay-' + (over.id ?? '1'), amount: 100, status: 'completed',
    paid_at: '2026-07-16T10:00:00Z', provider: 'etransfer', invoice_id: null,
    created_at: '2026-07-16T10:00:00Z', ...over,
  }) as unknown as PortalData['payments'][number]

  // TODAY is 2026-07-18, so the 30-day window opens on 2026-06-18.
  const rows = recentPayments([
    pay({ id: 'old', paid_at: '2026-05-01T10:00:00Z' }),          // outside the window
    pay({ id: 'new', paid_at: '2026-07-17T10:00:00Z', amount: 75 }),
    pay({ id: 'mid', paid_at: '2026-07-10T10:00:00Z', amount: 50 }),
  ], TODAY)
  check('recent payments: only inside the window, newest first',
    rows.length === 2 && rows[0].id === 'new' && rows[1].id === 'mid'
    && rows[0].amount === 75 && rows[1].amount === 50)
  check('recent payments: an e-transfer says how it was paid',
    rows[0].label === 'Payment received · E-transfer')
  check('recent payments: capped',
    recentPayments([pay({ id: 'a' }), pay({ id: 'b' }), pay({ id: 'c' }), pay({ id: 'd' })], TODAY).length === RECENT_PAYMENT_MAX)
  check('recent payments: nothing recent → the section has no rows to render',
    recentPayments([pay({ id: 'old', paid_at: '2026-01-01T10:00:00Z' })], TODAY).length === 0)
  check('recent payments: an empty/absent ledger claims nothing',
    recentPayments([], TODAY).length === 0 && recentPayments(null, TODAY).length === 0)

  // Classification is the ONE ledger classifier, never the sign of the amount —
  // a refund and an overpayment-moved-to-credit are both negative and only the
  // first is money leaving the business.
  const refund = recentPayments([pay({ id: 'r', amount: -50 })], TODAY)[0]
  check('recent payments: a refund is named as one and shows a positive magnitude',
    refund.label === 'Refund issued' && refund.isRefund === true && refund.amount === 50)
  const toCredit = recentPayments([pay({ id: 'c', amount: -50, provider: 'credit' })], TODAY)[0]
  check('recent payments: an overpayment moved to credit is NOT called a refund',
    toCredit.label === 'Overpayment moved to credit' && toCredit.isRefund === false)
  const fromCredit = recentPayments([pay({ id: 'f', amount: 50, provider: 'credit' })], TODAY)[0]
  check('recent payments: settling from credit says so',
    fromCredit.label === 'Settled from account credit')
  // The credit LEDGER stays out: Billing's "Available credit" tile is its story,
  // and repeating it here would state the same money twice.
  check('recent payments: credit-ledger rows are excluded',
    recentPayments([pay({ id: 'k', kind: 'credit' })], TODAY).length === 0)

  // ── The regression half: narrowing Home must not have removed an ANSWER. ──
  const homeSrc = readFileSync(join(process.cwd(), 'src/app/portal/[token]/components/HomeTab.tsx'), 'utf8')
  // A quote awaiting an answer, and the accept action itself.
  //
  // ⭐ Session 121 re-pointed the ACTION, not the answer. The one-tap shortcut
  // now passes the terms acknowledgement explicitly and is only rendered when
  // the business has NO terms — accepting from a card that never showed the
  // terms would be ticking the box on the customer's behalf. So the assertion
  // pins the accept door still being on Home AND that it is the terms-aware one;
  // a bare `actions.accept(oneQuoteId)` reappearing is the regression.
  check('Home still surfaces quotes awaiting an answer, with a terms-aware accept',
    homeSrc.includes("d.kind === 'quote' && d.status === 'sent'")
    && homeSrc.includes('quotes are ready for your review')
    && homeSrc.includes('actions.accept(oneQuoteId, undefined, true)')
    && homeSrc.includes('oneQuoteId && !hasTerms'))
  // Money owed, and the ability to pay it.
  check('Home still surfaces money owed and the way to pay it',
    homeSrc.includes('view.money.due > 0') && homeSrc.includes('Amount due')
    && homeSrc.includes('actions.pay(oneInvoice.rawId)'))
  // Upcoming work.
  check('Home still surfaces the next visit',
    homeSrc.includes('NEXT SERVICE') || homeSrc.includes('Next service'))
  // The one thing the old feed uniquely carried: an owner-recorded payment has no
  // other confirmation on Home (the checkout banner is Stripe-return only).
  // Not just "the code mentions payments" — the section must be gated on there
  // BEING rows. A guard that only greps for the call survives the section being
  // switched off, which is exactly the regression this whole check exists for.
  check('Home still confirms a payment landed',
    homeSrc.includes('recentPayments(') && homeSrc.includes('Recent payments')
    && /\{\s*payments\.length\s*>\s*0\s*&&/.test(homeSrc))
  // And the general ledger did NOT survive the narrowing.
  check('Home no longer rebuilds a general activity feed',
    !homeSrc.includes('useRecentActivity') && !homeSrc.includes('interface TLEvent')
    && !/Invoice \$\{d\.number\} issued/.test(homeSrc)
    && !/Quote \$\{q\.quote_number\} sent/.test(homeSrc))
  // One definition of the method word, so Home and Billing cannot drift.
  const paySrc = readFileSync(join(process.cwd(), 'src/app/portal/[token]/components/PaymentsSection.tsx'), 'utf8')
  check('paymentMethodLabel has exactly one definition, in the model',
    !/function paymentMethodLabel/.test(paySrc) && !/function paymentMethodLabel/.test(homeSrc))
}

console.log(`\n${fail === 0 ? '✓' : '✗'} portal checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
