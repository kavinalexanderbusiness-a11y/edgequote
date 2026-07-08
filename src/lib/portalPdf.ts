import type { Quote, Invoice, BusinessSettings } from '@/types'

// ── Portal PDF bridge ────────────────────────────────────────────────────────
// The portal renders the SAME quote/invoice PDFs as the dashboard. We map the
// token-scoped rows from get_portal_data into the full Quote/Invoice/
// BusinessSettings shapes the existing PDF documents expect, then call the SAME
// renderQuoteBlob / renderInvoiceBlob pipeline. One PDF system, no second copy.
// Security: get_portal_data only ever returns this token's customer's records,
// so a customer can only ever build their own documents.

export interface PortalPdfQuote {
  quote_number: string; service_type: string; address: string; total: number
  initial_price: number | null; subtotal: number | null
  weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null
  notes: string | null; status: string; created_at: string; issued_date: string | null
  crew_size: number | null; hours: number | null; travel_fee: number | null
}
export interface PortalPdfInvoice {
  invoice_number: string; service_type: string | null; amount: number; status: string
  issued_date: string | null; due_date: string | null; notes: string | null; address: string | null
  line_items: { description: string; amount: number; kind: string }[] | null; created_at: string
}
export interface PortalPdfBusiness {
  company_name: string | null; phone: string | null; email_primary: string | null
  email_secondary: string | null; website: string | null; logo_url: string | null
  logo_scale: number | null; base_address: string | null; terms_text: string | null
  gst_percent?: number | null
}

function num(v: unknown, fallback = 0): number { const n = Number(v); return Number.isFinite(n) ? n : fallback }

function portalQuoteToQuote(q: PortalPdfQuote, customerName: string): Quote {
  return {
    quote_number: q.quote_number,
    customer_name: customerName,
    address: q.address,
    service_type: q.service_type,
    notes: q.notes,
    hours: num(q.hours),
    crew_size: num(q.crew_size, 1) || 1,
    travel_fee: num(q.travel_fee),
    subtotal: num(q.subtotal ?? q.initial_price ?? q.total),
    total: num(q.total),
    initial_price: q.initial_price,
    weekly_price: q.weekly_price,
    biweekly_price: q.biweekly_price,
    monthly_price: q.monthly_price,
    status: q.status,
    issued_date: q.issued_date,
    created_at: q.created_at,
  } as unknown as Quote
}

function portalInvoiceToInvoice(inv: PortalPdfInvoice, customerName: string, fallbackAddress: string | null): Invoice {
  return {
    invoice_number: inv.invoice_number,
    customer_name: customerName,
    address: inv.address || fallbackAddress,
    service_type: inv.service_type,
    amount: num(inv.amount),
    status: inv.status,
    issued_date: inv.issued_date,
    due_date: inv.due_date,
    notes: inv.notes,
    line_items: inv.line_items,
    created_at: inv.created_at,
  } as unknown as Invoice
}

function portalBusinessToSettings(b: PortalPdfBusiness | null): BusinessSettings | null {
  if (!b) return null
  return {
    company_name: b.company_name || 'Your service provider',
    phone: b.phone,
    email_primary: b.email_primary,
    email_secondary: b.email_secondary,
    website: b.website,
    logo_url: b.logo_url,
    logo_scale: b.logo_scale ?? 100,
    base_address: b.base_address,
    terms_text: b.terms_text,
    gst_percent: b.gst_percent ?? 0,
  } as unknown as BusinessSettings
}

export async function renderPortalQuoteBlob(q: PortalPdfQuote, customerName: string, b: PortalPdfBusiness | null): Promise<Blob> {
  const { renderQuoteBlob } = await import('@/components/quotes/QuotePDF')
  return renderQuoteBlob(portalQuoteToQuote(q, customerName), portalBusinessToSettings(b))
}
export async function renderPortalInvoiceBlob(inv: PortalPdfInvoice, customerName: string, fallbackAddress: string | null, b: PortalPdfBusiness | null): Promise<Blob> {
  const { renderInvoiceBlob } = await import('@/components/quotes/InvoicePDF')
  return renderInvoiceBlob(portalInvoiceToInvoice(inv, customerName, fallbackAddress), portalBusinessToSettings(b))
}

// ── Device-friendly delivery of a generated PDF blob ─────────────────────────
// Download uses the <a download> hand-off (works on desktop + opens the viewer /
// share sheet on iOS). View opens the PDF in a tab. Print uses a hidden iframe
// on desktop and falls back to opening the PDF on mobile (where the native
// viewer provides Print / Share).
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
export function viewBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
export function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  iframe.src = url
  let triggered = false
  iframe.onload = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); triggered = true } catch { /* mobile: no iframe print */ }
  }
  document.body.appendChild(iframe)
  // Mobile browsers can't print a hidden iframe — open the PDF so the native
  // viewer's Print / Share is available.
  setTimeout(() => { if (!triggered) window.open(url, '_blank', 'noopener,noreferrer') }, 1500)
  setTimeout(() => { iframe.remove(); URL.revokeObjectURL(url) }, 60000)
}
