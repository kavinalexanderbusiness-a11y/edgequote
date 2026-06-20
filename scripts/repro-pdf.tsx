/* Repro for the "PDF not working" report. Renders the REAL InvoiceDocument and
   QuoteDocument server-side via @react-pdf/renderer to surface the actual error
   (the app swallows it in a catch{}). Run via esbuild bundle → node. */
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoiceDocument } from '../src/components/quotes/InvoicePDF'
import { QuoteDocument } from '../src/components/quotes/QuotePDF'

/* eslint-disable @typescript-eslint/no-explicit-any */
const settings: any = {
  company_name: 'Edge Property Services',
  logo_url: null,            // test without logo first (logo Image fetch is a separate failure mode)
  logo_scale: 100,
  phone: '403-555-0100',
  email_primary: 'kavin@example.com',
  base_address: '123 Base St, Calgary AB',
  website: 'edgeproperty.ca',
  terms_text: 'Payment due within 14 days.',
}
const invoice: any = {
  invoice_number: 'INV-0001', issued_date: '2026-06-14', due_date: '2026-06-28', created_at: '2026-06-14T12:00:00Z',
  customer_name: 'Jodi Smith', address: '123 Queensland Rd SE', service_type: 'Weekly Mowing', amount: 110, status: 'draft',
  line_items: [
    { description: 'Weekly Mowing', amount: 65, kind: 'service' },
    { description: 'Fertilizer', amount: 45, kind: 'addon' },
  ],
}
const invoiceNoLines: any = { ...invoice, invoice_number: 'INV-0002', line_items: null } // legacy path
const quote: any = {
  quote_number: 'EPS-0001', issued_date: '2026-06-14', created_at: '2026-06-14T12:00:00Z',
  customer_name: 'Jodi Smith', address: '123 Queensland Rd SE', service_type: 'Weekly Mowing',
  hours: 1, crew_size: 1, rate: 50, travel_fee: 0, subtotal: 50, total: 65, initial_price: 65,
  weekly_price: 50, biweekly_price: 60, monthly_price: 80, notes: 'Thanks!', status: 'draft',
  show_travel_separately: false, custom_travel_required: false,
}

async function one(label: string, el: any) {
  try { const buf = await renderToBuffer(el); console.log(`${label}: OK (${buf.length} bytes)`) }
  catch (e) { console.error(`\n${label}: FAILED\n`, e instanceof Error ? (e.stack || e.message) : e) }
}

async function main() {
  await one('INVOICE (with line_items)', <InvoiceDocument invoice={invoice} settings={settings} />)
  await one('INVOICE (legacy null line_items)', <InvoiceDocument invoice={invoiceNoLines} settings={settings} />)
  await one('QUOTE', <QuoteDocument quote={quote} settings={settings} />)
}
main()
