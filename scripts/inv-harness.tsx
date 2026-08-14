// ── Invoice-detail measurement harness (investigation tool, not a guard) ─────
// Renders the REAL InvoiceDetail (and therefore the real DepositRequestPanel and
// InvoicePaymentControls inside it) to static markup with representative props,
// wraps it in the REAL compiled Tailwind CSS, and writes an HTML file that
// headless Chrome lays out and measures via scripts/inv-cdp.mjs.
//
// Every number in the report comes from here + CDP. Source-class arithmetic is
// how the previous pass on this page measured, and it cannot see wrapping,
// media queries or a `position: fixed` bottom nav.
//
// ⚠️ Fixtures must satisfy the components' OWN filters, or the harness measures a
// different screen than it claims: `amount` is the pre-GST net, `amount_paid` is
// the GST-INCLUSIVE rollup the trigger writes, and a deposit needs
// `deposit_amount` (GST-inclusive) — mixing those up produces a state no invoice
// can actually be in.
//
// Usage: tsx scripts/inv-harness.tsx <outdir> <scenario>
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { InvoiceDetail } from '../src/components/payments/InvoiceDetail'
import type { Invoice, BusinessSettings, Payment } from '../src/types'

const outdir = process.argv[2] || '.inv'
const scenario = process.argv[3] || 'sent'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const TODAY = '2026-08-10'

const settings = {
  user_id: 'u', business_name: 'Edge Property Services', gst_percent: 5,
} as unknown as BusinessSettings

// A $4,000 net job → $4,200 GST-inclusive, which is the shape every deposit
// example in this codebase uses (50% = $2,100).
const baseInvoice = {
  id: 'i1', created_at: '2026-07-28T10:00:00Z', updated_at: '2026-07-28T10:00:00Z',
  user_id: 'u', quote_id: null, customer_id: 'c1', property_id: null, job_id: 'j1',
  invoice_number: 'INV-0042', customer_name: 'Jane Smith',
  address: '123 Elm St SW, Calgary', service_type: 'Spring cleanup + hedge trimming',
  amount: 4000, status: 'sent', issued_date: '2026-07-28', due_date: '2026-09-01',
  notes: 'Thanks for your business!', internal_notes: null,
  line_items: [
    { description: 'Spring cleanup', amount: 2600, kind: 'service' },
    { description: 'Hedge trimming (3 hrs)', amount: 1100, kind: 'addon' },
    { description: 'Travel', amount: 300, kind: 'travel' },
  ],
  discount_type: null, discount_value: null,
  deposit_amount: null, deposit_requested_at: null,
  amount_paid: 0, paid_at: null, payment_method: null, viewed_at: null,
  customers: { id: 'c1', name: 'Jane Smith', email: 'jane@example.com', phone: '4035550100' },
} as unknown as Invoice

const payment = (id: string, amount: number, method: string, paid_at: string) => ({
  id, created_at: paid_at, user_id: 'u', customer_id: 'c1', invoice_id: 'i1',
  amount, currency: 'cad', status: 'paid', kind: 'payment', method, provider: null,
  stripe_session_id: null, paid_at, notes: null,
} as unknown as Payment)

interface Scenario {
  inv: Partial<Invoice>
  payments?: Payment[]
  credit?: number
  hasSavedCard?: boolean
  paymentsEnabled?: boolean
  /** `?pay=1` — the field "Get paid" deep link lands with the form open. */
  payIntent?: boolean
}

// The eight states the owner will actually meet, plus the two that only the
// ledger can produce (overpaid) and the one the owner can only reach by hand
// (cancelled).
const SCENARIOS: Record<string, Scenario> = {
  // Auto-drafted by a completed job — not issued, not seen by anyone.
  draft: { inv: { status: 'draft', issued_date: null } },
  // Issued but not yet delivered.
  unpaid: { inv: { status: 'unpaid' } },
  // In the customer's hands, nothing paid.
  sent: { inv: {} },
  // A deposit was saved but the customer has not been told.
  'deposit-draft': { inv: { deposit_amount: 2100 } },
  // The ask has been sent; the money has not arrived.
  'deposit-sent': { inv: { deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z' } },
  // The deposit landed; the remainder is still to bill.
  'deposit-paid': {
    inv: { status: 'partial', amount_paid: 2100, deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z' },
    payments: [payment('p1', 2100, 'etransfer', '2026-08-03T14:00:00Z')],
  },
  // An ordinary part payment, no deposit involved.
  partial: {
    inv: { status: 'partial', amount_paid: 1500 },
    payments: [payment('p1', 1500, 'cheque', '2026-08-04T14:00:00Z')],
  },
  // Settled.
  paid: {
    inv: { status: 'paid', amount_paid: 4200, paid_at: '2026-08-06T14:00:00Z', payment_method: 'etransfer' },
    payments: [payment('p1', 2000, 'etransfer', '2026-08-03T14:00:00Z'), payment('p2', 2200, 'cheque', '2026-08-06T14:00:00Z')],
  },
  // Past its due date with money owing.
  overdue: { inv: { due_date: '2026-07-20' } },
  // Withdrawn — and still holding its full balance, which is the trap.
  cancelled: { inv: { status: 'cancelled' } },
  // The ledger's own state: more arrived than was invoiced.
  overpaid: {
    inv: { status: 'overpaid', amount_paid: 4500 },
    payments: [payment('p1', 4500, 'etransfer', '2026-08-05T14:00:00Z')],
  },
  // The field deep link: `?invoice=…&pay=1` from a completed job card, which must
  // land with the record-payment form already open and reachable without a hunt.
  payintent: { inv: {}, payIntent: true },
  // ⚠️ The Collapsible min-content trap (see the note in ui/Collapsible): with no
  // line items the disclosure's summary becomes the raw service_type, and a
  // truncating span still contributes its UN-WRAPPED width to the header row's
  // min-content. This is the scenario that proves the card can go narrower.
  'long-summary': {
    inv: {
      line_items: null,
      service_type: 'Seasonal grounds maintenance — spring cleanup, hedge trimming, turf repair and fall leaf removal',
      customer_name: 'Northbridge Commercial Property Management Ltd.',
    },
  },
  // Worst case for layout: a long customer name, credit available, a saved card.
  long: {
    inv: {
      customer_name: 'Northbridge Commercial Property Management Ltd.',
      service_type: 'Seasonal grounds maintenance — spring cleanup, hedge trimming and turf repair',
      status: 'partial', amount_paid: 1500, deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z',
    },
    payments: [payment('p1', 1500, 'etransfer', '2026-08-04T14:00:00Z')],
    credit: 120,
  },
}

const s = SCENARIOS[scenario]
if (!s) { console.error(`unknown scenario "${scenario}" — have: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1) }

const inv = { ...baseInvoice, ...s.inv } as Invoice
const noop = () => {}

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink"><div id="root"><div class="max-w-5xl mx-auto p-4 space-y-3">${
  renderToStaticMarkup(
    React.createElement(InvoiceDetail, {
      inv, settings, today: TODAY, uid: 'u', index: 0,
      payments: s.payments ?? [],
      credit: s.credit ?? 0,
      paymentsEnabled: s.paymentsEnabled ?? true,
      hasSavedCard: s.hasSavedCard ?? true,
      payIntent: s.payIntent ?? false,
      paying: false, charging: false, opening: false, deleting: false,
      editorOpen: false, editor: null,
      onToggleEditor: noop, onDownloadPdf: noop, onCardLink: noop, onChargeCard: noop,
      onSend: noop, onSendDepositRequest: noop, onDelete: noop, onSetStatus: noop,
      onApproveDraft: noop, onCancelInvoice: noop, onChanged: noop,
      onIssueDraft: async () => undefined,
    } as never),
  )
}</div></div></body></html>`

writeFileSync(join(outdir, `${scenario}.html`), html)
console.log(`${scenario}.html  ${(html.length / 1024).toFixed(0)} kB`)
