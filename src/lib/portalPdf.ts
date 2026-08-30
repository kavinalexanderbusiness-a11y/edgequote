import type { Quote, QuoteService, QuoteOption, Invoice, BusinessSettings, QuoteLineKind } from '@/types'

// ── Portal PDF bridge ────────────────────────────────────────────────────────
// The portal renders the SAME quote/invoice PDFs as the dashboard. We map the
// token-scoped rows from get_portal_data into the full Quote/Invoice/
// BusinessSettings shapes the existing PDF documents expect, then call the SAME
// renderQuoteBlob / renderInvoiceBlob pipeline. One PDF system, no second copy.
// Security: get_portal_data only ever returns this token's customer's records,
// so a customer can only ever build their own documents.

// One service line on a multi-service quote (from get_portal_data's nested
// quote_services array). Same fields the dashboard PDF consumes.
export interface PortalQuoteService {
  service_type: string; quantity: number; unit: string | null; unit_price: number
  est_minutes: number | null; discount_type: 'amount' | 'percent' | null
  discount_value: number | null; notes: string | null; sort_order: number
}

// One alternative, as get_portal_data's nested `options` array returns it.
export interface PortalQuoteOption {
  id: string; name: string; description: string | null; price: number
  sort_order: number; is_recommended: boolean
}

export interface PortalPdfQuote {
  quote_number: string; service_type: string; address: string; total: number
  initial_price: number | null; subtotal: number | null
  weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null
  notes: string | null; status: string; created_at: string; issued_date: string | null
  crew_size: number | null; hours: number | null; travel_fee: number | null
  services?: PortalQuoteService[] | null
  // The alternatives and WHICH one was taken. The customer's own copy of their
  // quote has to show the same options table the owner's copy does, or the
  // document they keep says something different from the one that was sent.
  options?: PortalQuoteOption[] | null
  selected_option_id?: string | null
}
export interface PortalPdfInvoice {
  invoice_number: string; service_type: string | null; amount: number; status: string
  issued_date: string | null; due_date: string | null; notes: string | null; address: string | null
  line_items: { description: string; amount: number; kind: string }[] | null; created_at: string
  amount_paid?: number | null; discount_type?: 'amount' | 'percent' | null; discount_value?: number | null
  // get_portal_data's invoice projection carries these, so the customer's OWN copy
  // shows the same "Due Now (Deposit)" the owner's copy and the Pay button do.
  // Without them the portal PDF printed the FULL total as due while the deposit
  // request in their inbox asked for half — the one document they'd act on
  // disagreeing with the message that reached them. Optional: an older cached
  // payload resolves to null, which is exactly "no deposit requested".
  deposit_amount?: number | null; deposit_requested_at?: string | null
}
export interface PortalPdfBusiness {
  company_name: string | null; phone: string | null; email_primary: string | null
  email_secondary: string | null; website: string | null; logo_url: string | null
  logo_scale: number | null; base_address: string | null; terms_text: string | null
  gst_percent?: number | null
  // get_portal_data's `business` projection selects this as of
  // RUN-2026-07-15-portal-gst-number.sql, so the customer's OWN copy of an invoice
  // — the one they hand their accountant — carries the registration number too.
  // Fixing only the owner-sent copy would have left the ITC hole on the path that
  // actually gets filed. Optional: an older cached payload simply resolves to null,
  // and the PDFs already print nothing unless registered.
  gst_number?: string | null
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
    // Ordering fixed: this PREFERRED the stale generated column
    // (hours * crew_size * rate) over the real price, on the CUSTOMER's own copy of
    // their quote. `initial_price` is the price the owner actually set; `total` adds
    // travel. The legacy column is not consulted at all — see the note in QuotePDF.
    subtotal: num(q.initial_price ?? q.total),
    total: num(q.total),
    initial_price: q.initial_price,
    weekly_price: q.weekly_price,
    biweekly_price: q.biweekly_price,
    monthly_price: q.monthly_price,
    status: q.status,
    issued_date: q.issued_date,
    created_at: q.created_at,
    // WHICH alternative was approved. Without this the customer's own PDF would
    // render an already-decided quote as though the choice were still open —
    // "Choose One Option" on a document for a job that is already booked.
    selected_option_id: q.selected_option_id ?? null,
  } as unknown as Quote
}

function portalInvoiceToInvoice(inv: PortalPdfInvoice, customerName: string, fallbackAddress: string | null): Invoice {
  return {
    invoice_number: inv.invoice_number,
    customer_name: customerName,
    address: inv.address || fallbackAddress,
    service_type: inv.service_type,
    amount: num(inv.amount),
    // Paid-to-date + discount must survive the mapping — the customer's PDF has to
    // show the same Balance Due the owner's InvoicePDF and the portal balance show.
    amount_paid: num(inv.amount_paid ?? 0),
    discount_type: inv.discount_type ?? null,
    discount_value: inv.discount_value ?? null,
    // Same reason as amount_paid above: the deposit ask has to survive the mapping
    // or the customer's PDF asks for the full total the owner didn't request yet.
    deposit_amount: inv.deposit_amount ?? null,
    deposit_requested_at: inv.deposit_requested_at ?? null,
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
    gst_number: b.gst_number ?? null,
  } as unknown as BusinessSettings
}

export async function renderPortalQuoteBlob(q: PortalPdfQuote, customerName: string, b: PortalPdfBusiness | null): Promise<Blob> {
  const { renderQuoteBlob } = await import('@/components/quotes/QuotePDF')
  // Multi-service breakdown flows into the SAME PDF pipeline the dashboard uses —
  // the customer sees every service line, not a lump sum under one service name.
  const services: QuoteService[] | undefined = q.services?.length
    ? q.services.map((s, i) => ({
        id: String(i), created_at: q.created_at, user_id: '', quote_id: '',
        service_type: s.service_type, service_template_id: null,
        quantity: num(s.quantity, 1) || 1, unit: s.unit, unit_price: num(s.unit_price),
        est_minutes: s.est_minutes, discount_type: s.discount_type,
        discount_value: s.discount_value, notes: s.notes, sort_order: s.sort_order,
        // The portal RPC doesn't return `kind`, so this defaults — which is inert
        // rather than wrong: the PDF renders every line as name × qty × price and
        // branches on nothing. A material still reads correctly to the customer
        // ("Mulch · 5 yd³ · $225"); what it doesn't get is a grouped Materials
        // heading. Giving it one means widening get_portal_data, which is a frozen
        // surface and outside this slice.
        kind: (s as { kind?: QuoteLineKind }).kind ?? 'service',
      }))
    : undefined
  // The alternatives ride through the SAME pipeline — one PDF system, so the copy
  // the customer downloads is the copy the owner sent, options table and all.
  const options: QuoteOption[] | undefined = q.options?.length
    ? q.options.map(o => ({
        id: o.id, created_at: q.created_at, updated_at: q.created_at,
        quote_id: '', user_id: '',
        name: o.name, description: o.description,
        price: num(o.price), sort_order: Number(o.sort_order) || 0,
        is_recommended: !!o.is_recommended,
      }))
    : undefined
  return renderQuoteBlob(portalQuoteToQuote(q, customerName), portalBusinessToSettings(b), services, options)
}

// ── The ACCEPTED VERSION, customer side (Session 112 · accepted-document-truth) ─
// Fed from the acceptance projection get_portal_data attaches to the quote —
// the immutable `document` snapshot and the exact terms text agreed — through
// lib/acceptedDocument into the SAME renderQuoteBlob pipeline, with the
// accepted stamp set. ⛔ Not one material figure here comes from the live quote
// row: `q` supplies only presentation facts (id, created_at, issued_date) the
// snapshot deliberately does not carry.
export interface PortalPdfAcceptance {
  accepted_at: string
  /** The evidence kind — decides the document's label; never inferred. */
  kind: import('@/lib/quoteAcceptance').AcceptanceKind
  accepted_amount?: number | string | null
  selected_option_id: string | null
  document: import('@/lib/quoteAcceptance').AcceptedDocument
  terms_text: string | null
}

export async function renderPortalAcceptedQuoteBlob(
  q: Pick<PortalPdfQuote, 'created_at' | 'issued_date'> & { id?: string },
  acc: PortalPdfAcceptance,
  b: PortalPdfBusiness | null,
): Promise<Blob> {
  const [{ renderQuoteBlob }, { acceptedRenderInput }] = await Promise.all([
    import('@/components/quotes/QuotePDF'),
    import('@/lib/acceptedDocument'),
  ])
  const input = acceptedRenderInput({
    document: acc.document,
    acceptedAt: acc.accepted_at,
    selectedOptionId: acc.selected_option_id,
    termsText: acc.terms_text,
    kind: acc.kind,
    presentation: { quoteId: q.id ?? '', createdAt: q.created_at, issuedDate: q.issued_date },
  })
  return renderQuoteBlob(input.quote, portalBusinessToSettings(b), input.services, input.options, input.accepted)
}
// A payment row as the portal sees it — enough for the receipt document.
export interface PortalPdfPayment {
  id: string; amount: number; provider: string; method?: string | null
  paid_at: string | null; created_at: string; notes?: string | null
  kind?: string; currency?: string; status?: string
}

// Customer-side receipt: the SAME ReceiptPDF the owner uses, fed through the
// portal→Invoice/Settings mappers — one receipt engine, permanently re-renderable
// from the ledger row (receipts are never stored, so they can't drift).
export async function renderPortalReceiptBlob(payment: PortalPdfPayment, inv: PortalPdfInvoice, customerName: string, fallbackAddress: string | null, b: PortalPdfBusiness | null): Promise<Blob> {
  const { renderReceiptBlob } = await import('@/components/payments/ReceiptPDF')
  return renderReceiptBlob(
    payment as unknown as import('@/types').Payment,
    portalInvoiceToInvoice(inv, customerName, fallbackAddress),
    portalBusinessToSettings(b),
  )
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
