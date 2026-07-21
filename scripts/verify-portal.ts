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
  quoteJourney, moneySummary, buildPropertyModels, customerSinceYear,
  requestPresetsOf, resolveDocAddress, groupPhotos, orphanPhotos, liveStatusOf, visitDay,
  daysAwayLabel, parsePortalDeepLink, tabNavTarget, buildVisitICS, visitToCalendarEvent,
  messageAboutDoc, NO_PROPERTY, MAX_REQUEST_PRESETS,
  type PortalData, type PortalJob, type PortalProperty, type DocBlobRenderers,
} from '../src/app/portal/[token]/model'

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
  status: 'scheduled', on_my_way_at: null, started_at: null, completed_at: null, notes: null, ...over,
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
  check('sent quote: plan line says (per visit)', sent.lines?.some(l => l.label.includes('(per visit)')) === true)
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
  check('partial: "already paid" note', late.amountNote?.includes('already paid') === true)
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

console.log(`\n${fail === 0 ? '✓' : '✗'} portal checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
