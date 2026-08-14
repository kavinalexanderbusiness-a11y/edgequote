import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { stripeEnabled, webhookConfigured } from '@/lib/stripe/config'
import { tenantCapabilities } from '@/lib/capabilities'

export const dynamic = 'force-dynamic'

// ── THE payments-availability read, now tenant-aware ─────────────────────────
// `enabled` used to answer "does the DEPLOYMENT hold a Stripe key?" — the wrong
// question the moment a second business exists, because the key belongs to the
// founding tenant. It now answers "may THIS tenant take online payments":
// the deployment key AND the tenant's platform online_payments grant
// (lib/capabilities). Every Pay button in the dashboard and the portal renders
// off this answer, so a restricted tenant sees payments as intentionally
// unavailable, never as broken.
//
// WHO is "this tenant":
//   • dashboard callers — the signed-in session (RLS lets a user read only their
//     own grant row; no session → pessimistic false).
//   • the customer portal — no session exists, so the client passes its portal
//     token as ?portal=<token> and the OWNER is resolved server-side from the
//     token table. The token names the tenant; the client never does.
//
// `reason` is for honest UI copy only ('not-configured' → "connect Stripe",
// 'not-enabled' → "not enabled for this business"); the server doors enforce
// the same answer regardless of what the UI believed. No secrets leave here —
// booleans and a word.
export async function GET(req: NextRequest) {
  const configured = stripeEnabled()
  let allowed = false

  const portalToken = req.nextUrl.searchParams.get('portal')
  if (portalToken) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (url && svc) {
      const admin = createServiceClient(url, svc)
      const { data: tok } = await admin.from('customer_portal_tokens')
        .select('user_id').eq('token', portalToken).eq('revoked', false).maybeSingle()
      const ownerId = (tok as { user_id: string } | null)?.user_id ?? null
      if (ownerId) allowed = (await tenantCapabilities(admin, ownerId)).onlinePayments
    }
  } else {
    const supabase = await createServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) allowed = (await tenantCapabilities(supabase, user.id)).onlinePayments
  }

  const enabled = configured && allowed
  return NextResponse.json({
    enabled,
    webhook: webhookConfigured(),
    reason: enabled ? 'ok' : !configured ? 'not-configured' : 'not-enabled',
  })
}
