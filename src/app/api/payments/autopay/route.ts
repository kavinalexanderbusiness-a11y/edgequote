import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { attemptAutoPayCharge } from '@/lib/payments/autopay'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Charge a recurring invoice to the customer's saved card OFF-SESSION. Called by the
// invoicing fire-and-forget on visit completion (manual=false) and by the owner's
// "Charge card" button on the Invoices page (manual=true). Thin auth wrapper around
// the shared attemptAutoPayCharge engine (the cron sweep calls the same engine), so
// there is exactly ONE charge flow. The webhook records the payment + flips the
// invoice paid (one writer of paid-state).
export async function POST(req: NextRequest) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const invoiceId = String(body.invoiceId || '')
  const manual = body.manual === true   // owner-initiated → bypass autopay-enabled + anomaly hold
  if (!invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!svc) return NextResponse.json({ result: 'skipped', reason: 'server-misconfigured' })
  // Service role for the charge work; user_id is the authenticated owner, so the
  // engine's .eq('user_id', userId) filters keep it scoped to this owner's data.
  const sb = createServiceClient(url, svc)
  const result = await attemptAutoPayCharge(sb, { invoiceId, userId: user.id, manual })
  return NextResponse.json(result)
}
