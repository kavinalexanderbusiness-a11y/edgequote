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
// It also renders the accepted-version PDF FOR REAL (renderQuoteBlob with the
// accepted stamp, via the snapshot mapper) and writes the bytes out — proof the
// snapshot-fed pipeline produces an actual document, not just props.

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { DocRow } from '../src/app/portal/[token]/components/BillingTab'
import type { DocItem } from '../src/app/portal/[token]/model'
import type { PortalActions } from '../src/app/portal/[token]/components/shared'
import { acceptedRenderInput } from '../src/lib/acceptedDocument'
import type { AcceptedDocument } from '../src/lib/quoteAcceptance'

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

const baseDoc = (over: Partial<DocItem> = {}): DocItem => ({
  id: 'qQ1', rawId: 'Q1', kind: 'quote', number: 'Q-1042', title: 'Lawn care',
  date: '2026-08-02', status: 'accepted', validUntil: '2027-01-15',
  amount: 5550, balance: 0, payAmount: 0, payIsDeposit: false,
  filename: 'Q-1042-accepted.pdf', getBlob: blob,
  selectedOptionId: null, propertyId: null, address: '12 Elm St SW',
  ...over,
} as DocItem)

// ── The three states the customer can meet ───────────────────────────────────
const SCENES: Record<string, React.ReactElement> = {
  // Accepted, unchanged: the row's download IS the accepted version, and says so.
  'portal-standing': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      acceptedVersion: { at: '2026-08-20T10:00:00Z', amount: 5550, needsReapproval: false, filename: 'Q-1042-accepted.pdf', getBlob: blob },
    })} />
  ),
  // Accepted, then edited (fingerprint drifted): accepted figure holds the
  // headline, the amber note says a revision is coming, download stays the snapshot.
  'portal-drifted': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      amountNote: 'This is the price you accepted — we’ve made changes since and will send you an updated quote to look over.',
      acceptedVersion: { at: '2026-08-20T10:00:00Z', amount: 5550, needsReapproval: true, filename: 'Q-1042-accepted.pdf', getBlob: blob },
    })} />
  ),
  // Re-sent for approval: the row is the UPDATE, announced as one, with the
  // previously-accepted version beside it as its own labelled artifact.
  'portal-resent': (
    <DocRow termsText={null} actions={actions} d={baseDoc({
      status: 'sent', amount: 6225, filename: 'Q-1042.pdf',
      acceptedVersion: { at: '2026-08-20T10:00:00Z', amount: 5550, needsReapproval: true, filename: 'Q-1042-accepted.pdf', getBlob: blob },
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

// ── The accepted PDF, rendered for real from the snapshot ────────────────────
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

async function renderPdf() {
  const { renderQuoteBlob } = await import('../src/components/quotes/QuotePDF')
  const input = acceptedRenderInput({
    document: SNAP, acceptedAt: '2026-08-20T10:00:00Z', selectedOptionId: null,
    termsText: 'Payment due on completion. Cancellations need 24 hours notice.',
    presentation: { quoteId: 'q1', createdAt: '2026-08-01T09:00:00Z', issuedDate: '2026-08-02' },
  })
  const b = await renderQuoteBlob(input.quote, {
    company_name: 'Fixture Yard', phone: '403-555-0100', email_primary: 'hi@fixture.test',
    base_address: '1 Shop Rd', gst_percent: 5,
  } as never, input.services, input.options, input.accepted)
  const buf = Buffer.from(await b.arrayBuffer())
  writeFileSync(join(outdir, 'accepted-version.pdf'), buf)
  const magic = buf.subarray(0, 5).toString() === '%PDF-'
  console.log(`accepted PDF: ${buf.length} bytes, magic ${magic ? 'OK' : 'MISSING'}`)
  if (!magic || buf.length < 4000) { console.error('PDF PROOF FAILED'); process.exit(1) }
}
renderPdf().then(() => console.log('harness done'))
