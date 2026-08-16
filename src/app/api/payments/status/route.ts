import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { stripeEnabled, webhookConfigured } from '@/lib/stripe/config'
import { tenantCapabilities } from '@/lib/capabilities'
import { tipConfig, TIPS_OFF, type TipConfig, type TipSettings } from '@/lib/payments/tips'

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
// `tips` rides along on this same answer rather than getting a door of its own,
// and rather than being widened into get_portal_data (whose business projection
// is an explicit allow-list, and whose `create or replace` chain silently rolls
// back an older definition when re-issued). This route ALREADY resolves the
// owner server-side from the portal token, which is exactly what a tip config
// needs — the client names a token, never a tenant.
//
// A tip offer is gated TWICE and fails closed on both: `enabled` (deployment key
// AND the tenant's online_payments grant) and the owner's own tips_enabled. Tips
// cannot outlive the capability that carries them — the money settles into the
// same Stripe account, so a tenant that may not take card payments may not take
// card tips either. The portal renders off this; /api/portal/pay re-derives the
// identical answer server-side and is what actually enforces it.
export async function GET(req: NextRequest) {
  const configured = stripeEnabled()
  let allowed = false
  let tips: TipConfig = TIPS_OFF

  const portalToken = req.nextUrl.searchParams.get('portal')
  if (portalToken) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (url && svc) {
      const admin = createServiceClient(url, svc)
      const { data: tok } = await admin.from('customer_portal_tokens')
        .select('user_id').eq('token', portalToken).eq('revoked', false).maybeSingle()
      const ownerId = (tok as { user_id: string } | null)?.user_id ?? null
      if (ownerId) {
        allowed = (await tenantCapabilities(admin, ownerId)).onlinePayments
        if (allowed) {
          const { data: bs } = await admin.from('business_settings')
            .select('tips_enabled, tip_presets, tip_custom_enabled').eq('user_id', ownerId).maybeSingle()
          tips = tipConfig(bs as TipSettings | null)
        }
      }
    }
  } else {
    const supabase = await createServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      allowed = (await tenantCapabilities(supabase, user.id)).onlinePayments
      if (allowed) {
        const { data: bs } = await supabase.from('business_settings')
          .select('tips_enabled, tip_presets, tip_custom_enabled').eq('user_id', user.id).maybeSingle()
        tips = tipConfig(bs as TipSettings | null)
      }
    }
  }

  const enabled = configured && allowed
  return NextResponse.json({
    enabled,
    webhook: webhookConfigured(),
    reason: enabled ? 'ok' : !configured ? 'not-configured' : 'not-enabled',
    tips: enabled ? tips : TIPS_OFF,
  })
}
