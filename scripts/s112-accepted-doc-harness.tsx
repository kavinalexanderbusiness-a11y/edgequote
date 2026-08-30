// ── Session 112 accepted-document-truth harness ──────────────────────────────
//   npm run build && npx tsx --tsconfig tsconfig.harness.json scripts/s112-accepted-doc-harness.tsx .s112b
//
// Renders the REAL portal DocRow to static markup, wrapped in the REAL compiled
// Tailwind CSS, so headless Chrome can lay it out and MEASURE it at
// desktop / 375 / 390 / 430 (scripts/s112-accepted-doc-cdp.mjs) — the S121
// harness pattern, for the S121 reason:
//
// ⭐ WHY A HARNESS AND NOT THE RUNNING APP. Every state here depends on the
// portal acceptance projection this session deliberately has NOT applied to
// production. Against the live payload the row renders its degraded (pre-
// projection) branch and nothing else — measuring that would be measuring the
// wrong screen. The DATABASE behaviour is proved separately and exhaustively by
// verify:accepted-document-truth against a Postgres built from these very
// migrations; the OWNER surface is proved live against a local build (the
// ledger it reads DOES exist in production).
//
// THE FIVE REVIEW STATES, one scene each:
//   A portal-customer-standing   real customer acceptance, unchanged
//   B portal-onbehalf-standing   owner recorded it on the customer's behalf
//   C portal-legacy-standing     legacy backfill — no original evidence
//   D portal-drifted             accepted, then materially edited (reapproval due)
//   E portal-resent              revision re-sent; prior artifact rides beside it
//
// It also renders the accepted-version PDF FOR REAL — once per evidence kind —
// through the snapshot mapper, proving the pipeline produces actual documents.

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { DocRow } from '../src/app/portal/[token]/components/BillingTab'
import type { DocItem } from '../src/app/portal/[token]/model'
import type { PortalActions } from '../src/app/portal/[token]/components/shared'
import { acceptedRenderInput } from '../src/lib/acceptedDocument'
import type { AcceptedDocument, AcceptanceKind } from '../src/lib/quoteAcceptance'

const outdir = process.argv[2] || '.s112b'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const noop = () => { /* static render */ }
const actions = {
  token: 'tok', accept: noop, accepting: null, pay: noop, payingId: null,
  paymentsEnabled: true, payQuoteDeposit: noop, payingQuoteId: null,
  savePreference: async () => null, paymentPending: false, request: noop,
  submitRequest: async () => null, uploadRequestPhotos: async () => ({ paths: [], failed: 0 }),
  photoUrl: () => '', markInvoiceViewed: noop, refresh: noop, navigate: noop,
  askAbout: noop, respondToChange: async () => null, decidingChangeId: null,
} as unknown as PortalActions

const blob = async () => new Blob(['x'], { type: 'application/pdf' })
const AT = '2026-08-20T10:00:00Z'

const av = (kind: AcceptanceKind, needsReapproval = false) => ({
  at: AT, kind, amount: 5550, needsReapproval,
  filename: `Q-1042-${kind === 'legacy_unrecorded' ? 'record' : 'accepted'}.pdf`, getBlob: blob,
})
const baseDoc = (over: Partial<DocItem> = {}): DocItem => ({
  id: 'qQ1', rawId: 'Q1', kind: 'quote', number: 'Q-1042', title: 'Lawn care',
  date: '2026-08-02', status: 'accepted', validUntil: '2027-01-15',
  amount: 5550, balance: 0, payAmount: 0, payIsDeposit: false,
  filename: 'Q-1042-accepted.pdf', getBlob: blob,
  selectedOptionId: null, propertyId: null, address: '12 Elm St SW',
  ...over,
} as DocItem)

const SCENES: Record<string, React.ReactElement> = {
  // A — the customer really accepted, and nothing has changed since.
  'portal-customer-standing': (
    <DocRow termsText={null} actions={actions} d={baseDoc({ acceptedVersion: av('customer') })} />
  ),
  // B — staff recorded a decision that arrived by phone/email/in person.
  'portal-onbehalf-standing': (
    <DocRow termsText={null} actions={actions} d={baseDoc({ acceptedVersion: av('owner_on_behalf') })} />
  ),
  // C — legacy backfill: the old system had it marked accepted; the original
  // evidence was never captured, and the row must not claim more.
  'portal-legacy-standing': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      filename: 'Q-1042-record.pdf', acceptedVersion: av('legacy_unrecorded'),
    })} />
  ),
  // D — accepted, then materially edited: the accepted figure holds the
  // headline, the amber note says a revision is coming, download = snapshot.
  'portal-drifted': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      amountNote: 'This is the price you accepted — we’ve made changes since and will send you an updated quote to look over.',
      acceptedVersion: av('customer', true),
    })} />
  ),
  // E — the revision is re-sent: the row is the UPDATE, announced as one, with
  // the previously-accepted version beside it as its own labelled artifact.
  'portal-resent': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      status: 'sent', amount: 6225, filename: 'Q-1042.pdf',
      acceptedVersion: av('customer', true),
    })} />
  ),
}

for (const [name, el] of Object.entries(SCENES)) {
  const body = renderToStaticMarkup(el)
  writeFileSync(join(outdir, `${name}.html`), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head>
<body class="bg-bg text-ink" style="margin:0"><div style="padding:12px">${body}</div></body></html>`)
  console.log(`scene: ${name}.html (${body.length} bytes of markup)`)
}

// ── The accepted PDF, rendered for real, once per evidence kind ──────────────
const SNAP: AcceptedDocument = {
  quote_number: 'Q-1042', customer_name: 'Dana Reyes', address: '12 Elm St SW, Calgary',
  service_type: 'Lawn care', notes: 'Front and back, gate code 4417',
  initial_price: 5400, travel_fee: 150, total: 5550, valid_until: '2027-01-15',
  deposit_type: 'percent', deposit_value: 20,
  plan_prices: { weekly: 60, biweekly: 90, monthly: 140 },
  option: null, options_offered: [], addons: [],
  services: [
    { service_type: 'Mowing', quantity: 1, unit: null, unit_price: 5000, discount_type: null, discount_value: null, notes: 'front + back', kind: 'service' },
    { service_type: 'Mulch', quantity: 5, unit: 'yd3', unit_price: 80, discount_type: null, discount_value: null, notes: null, kind: 'material' },
  ],
}

async function renderPdfs() {
  const { renderQuoteBlob } = await import('../src/components/quotes/QuotePDF')
  for (const kind of ['customer', 'owner_on_behalf', 'legacy_unrecorded'] as AcceptanceKind[]) {
    const input = acceptedRenderInput({
      document: SNAP, acceptedAt: AT, selectedOptionId: null,
      termsText: 'Payment due on completion. Cancellations need 24 hours notice.',
      kind,
      presentation: { quoteId: 'q1', createdAt: '2026-08-01T09:00:00Z', issuedDate: '2026-08-02' },
    })
    const b = await renderQuoteBlob(input.quote, {
      company_name: 'Fixture Yard', phone: '403-555-0100', email_primary: 'hi@fixture.test',
      base_address: '1 Shop Rd', gst_percent: 5,
    } as never, input.services, input.options, input.accepted)
    const buf = Buffer.from(await b.arrayBuffer())
    writeFileSync(join(outdir, `accepted-${kind}.pdf`), buf)
    const magic = buf.subarray(0, 5).toString() === '%PDF-'
    console.log(`accepted PDF (${kind}): ${buf.length} bytes, magic ${magic ? 'OK' : 'MISSING'}`)
    if (!magic || buf.length < 4000) { console.error('PDF PROOF FAILED'); process.exit(1) }
  }
}
renderPdfs().then(() => console.log('harness done'))
