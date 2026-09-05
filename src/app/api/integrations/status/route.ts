import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tenantCapabilities } from '@/lib/capabilities'
import { commsEnabled } from '@/lib/comms/send'
import { stripeEnabled, webhookConfigured } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

// Configuration and the canonical tenant gate only. This never contacts a
// provider, returns credentials, or reports successful delivery/settlement.
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Sign in to check connections.' }, { status: 401, headers })

    // Use the signed-in owner's own settings row under RLS. A crew session or
    // caller-supplied tenant ID cannot inspect another business's availability.
    const { data: business, error } = await supabase.from('business_settings')
      .select('user_id').eq('user_id', user.id).maybeSingle()
    if (error) return NextResponse.json({ error: 'Could not check connections.' }, { status: 503, headers })
    if (!business) return NextResponse.json({ error: 'Business owner access required.' }, { status: 403, headers })

    const allowed = await tenantCapabilities(supabase, user.id)
    const configured = commsEnabled()
    // The canonical capability gate intentionally coalesces missing grants and
    // failed grant reads to false. Report only availability, never infer which
    // provider is disconnected or why access is unavailable.
    return NextResponse.json({
      email: configured.email && allowed.outboundEmail,
      sms: configured.sms && allowed.outboundSms,
      payments: stripeEnabled() && webhookConfigured() && allowed.onlinePayments,
    }, { headers })
  } catch {
    return NextResponse.json({ error: 'Could not check connections.' }, { status: 503, headers })
  }
}
