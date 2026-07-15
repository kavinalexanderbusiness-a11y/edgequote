import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { stripeEnabled, webhookConfigured } from '@/lib/stripe/config'
import { attemptAutoPayCharge } from '@/lib/payments/autopay'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// AutoPay SAFETY NET (Vercel Cron → see vercel.json). The primary charge happens via
// the fire-and-forget on visit completion; if that request is dropped (tab closed,
// network blip), the recurring invoice sits as an unbilled DRAFT. This sweep finds
// those and runs each through the SAME attemptAutoPayCharge engine — which dedupes
// (pre-charge DB check + Stripe Idempotency-Key), so re-running can NEVER double-
// charge. Fully guarded: needs CRON_SECRET, no-ops without Stripe/webhook/service key.
const LOOKBACK_DAYS = 14   // only recent auto-drafts (older ones the owner is handling)
const MAX_PER_RUN = 500

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (!stripeEnabled() || !webhookConfigured()) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Stripe/webhook not configured — AutoPay sweep is a no-op.' })
  }
  const sb = serviceClient()
  if (!sb) return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY.' })

  // Eligible customers = AutoPay enabled AND has a saved card (intersection).
  const [{ data: apRows }, { data: pmRows }] = await Promise.all([
    sb.from('customers').select('id').eq('autopay_enabled', true),
    sb.from('payment_methods').select('customer_id'),
  ])
  const cardSet = new Set(((pmRows as { customer_id: string }[] | null) || []).map(r => r.customer_id))
  const eligibleCustomerIds = ((apRows as { id: string }[] | null) || []).map(r => r.id).filter(id => cardSet.has(id))
  if (eligibleCustomerIds.length === 0) {
    return NextResponse.json({ ok: true, candidates: 0, charged: 0, note: 'No AutoPay customers with a saved card.' })
  }

  // Their recurring auto-DRAFT invoices from the recent window, not yet charged.
  // (Only 'draft' — the state the fire-and-forget targets. A draft the owner moved to
  // unpaid/sent is a deliberate manual action and is left alone.) The engine re-checks
  // charge-mode + anomaly + the already-charged dedupe per invoice.
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()
  const { data: invRows, error } = await sb.from('invoices')
    .select('id, user_id')
    .eq('status', 'draft').not('job_id', 'is', null)
    .gte('created_at', cutoff)
    .in('customer_id', eligibleCustomerIds)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN + 1)
  if (error) {
    console.error('[cron/autopay] invoice query failed:', error.message)
    return NextResponse.json({ ok: false, error: 'query failed' }, { status: 500 })
  }
  const invoices = (invRows as { id: string; user_id: string }[] | null) || []
  const truncated = invoices.length > MAX_PER_RUN
  const batch = invoices.slice(0, MAX_PER_RUN)

  const tally: Record<string, number> = {}
  for (const inv of batch) {
    try {
      const r = await attemptAutoPayCharge(sb, { invoiceId: inv.id, userId: inv.user_id, manual: false })
      tally[r.result] = (tally[r.result] || 0) + 1
    } catch (e) {
      console.error(`[cron/autopay] charge threw for invoice ${inv.id}:`, e)
      tally.error = (tally.error || 0) + 1
    }
  }

  const summary = { ok: true, candidates: batch.length, charged: tally.charged || 0, held: tally.held || 0, declined: tally.declined || 0, skipped: tally.skipped || 0, errors: tally.error || 0, truncated }
  // Log only when there was something to do, so quiet runs stay quiet in the logs.
  if (batch.length > 0) console.log('[cron/autopay] sweep:', JSON.stringify(summary))
  if (truncated) console.warn(`[cron/autopay] hit MAX_PER_RUN=${MAX_PER_RUN}; more drafts remain for the next run.`)
  return NextResponse.json(summary)
}
