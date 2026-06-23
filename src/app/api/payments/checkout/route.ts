import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createInvoiceCheckoutSession, stripeEnabled } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

// Owner-initiated checkout: build a hosted payment link for ONE of their own
// invoices (to take a card in person or text the link). The invoice — and its
// amount — is re-read server-side, scoped to the signed-in owner; the client
// only supplies an invoiceId.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const invoiceId = String(body.invoiceId || '')
  if (!invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: inv } = await supabase.from('invoices')
    .select('id, invoice_number, service_type, amount, status, user_id, customer_id, customers(email)')
    .eq('id', invoiceId).eq('user_id', user.id).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
  const invoice = inv as unknown as {
    id: string; invoice_number: string; service_type: string | null; amount: number | string
    status: string; user_id: string; customer_id: string | null; customers?: { email: string | null } | null
  }
  if (invoice.status === 'paid') return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 409 })

  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
  const result = await createInvoiceCheckoutSession(invoice, {
    successUrl: `${base}/dashboard/invoices?paid=1`,
    cancelUrl: `${base}/dashboard/invoices`,
    customerEmail: invoice.customers?.email ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
