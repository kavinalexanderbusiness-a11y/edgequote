import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { stripeEnabled } from '@/lib/stripe/config'
import { reconcileStripe } from '@/lib/payments/reconcile'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Owner-triggered "did any money never reach my books?". READ-ONLY by design: it
// reports what Stripe has and the ledger doesn't, and writes nothing. Thin auth
// wrapper around the shared reconcileStripe engine.
//
// Not a cron. Answering this calls the Stripe API repeatedly, and the honest use is
// deliberate — the owner asking after a webhook outage — not a background job
// re-listing the whole account forever.
const DEFAULT_DAYS = 90
const MAX_DAYS = 365

export async function POST(req: NextRequest) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!stripeEnabled()) {
    return NextResponse.json({ error: 'Stripe isn’t connected, so there’s nothing to reconcile against.' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const days = Math.min(Math.max(Math.floor(Number(body.days)) || DEFAULT_DAYS, 1), MAX_DAYS)
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  // Service role: the ledger read is scoped by userId inside the engine, and this
  // must see rows regardless of how RLS is shaped for the payments table.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  const sb = createServiceClient(url, svc)

  const report = await reconcileStripe(sb, { userId: user.id, sinceIso })
  // A failed read is a failed read — never a clean bill of health.
  if (!report.ok) return NextResponse.json({ error: report.error || 'Could not reconcile.' }, { status: 502 })
  return NextResponse.json({ ...report, days })
}
