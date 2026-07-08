import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createInvoiceCheckoutSession, stripeEnabled } from '@/lib/stripe/config'
import { invoiceTotals } from '@/lib/invoiceTotals'

export const dynamic = 'force-dynamic'

// Public, token-scoped: a customer pays an invoice from their portal. The RPC
// (SECURITY DEFINER) verifies the invoice belongs to the token's customer AND is
// still owing, and returns the amount — so a malicious client can't pay/peek
// another customer's invoice or tamper with the amount.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const invoiceId = String(body.invoiceId || '')
  if (!token || !invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: invJson } = await anon.rpc('portal_invoice_for_payment', { p_token: token, p_invoice_id: invoiceId })
  if (!invJson) return NextResponse.json({ error: 'This invoice is not available to pay.' }, { status: 404 })
  const invoice = invJson as {
    id: string; invoice_number: string; service_type: string | null; amount: number | string; amount_paid?: number | null
    status: string; user_id: string; customer_id: string | null; gst_percent?: number | null
  }
  // Charge the remaining BALANCE (GST-inclusive total minus payments already
  // recorded). The RPC doesn't return gst_percent, so resolve it from the owner's
  // business_settings server-side (service role — anon can't read settings); a
  // GST-registered business must charge tax on portal payments too.
  let gst = Number(invoice.gst_percent)
  if (!Number.isFinite(gst)) {
    gst = 0
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (url && svc) {
      const admin = createClient(url, svc)
      const { data: bs } = await admin.from('business_settings').select('gst_percent').eq('user_id', invoice.user_id).maybeSingle()
      gst = Number((bs as { gst_percent?: number | null } | null)?.gst_percent) || 0
    }
  }
  const total = invoiceTotals(invoice.amount, { gst_percent: gst }).total
  const balance = Math.round((total - (Number(invoice.amount_paid) || 0)) * 100) / 100
  if (balance <= 0) return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 409 })

  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
  const result = await createInvoiceCheckoutSession(invoice, {
    successUrl: `${base}/portal/${token}?paid=1`,
    cancelUrl: `${base}/portal/${token}`,
    chargeCents: Math.round(balance * 100),
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
