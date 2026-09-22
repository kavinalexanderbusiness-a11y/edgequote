import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logSafeServerError } from '@/lib/serverError'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Owner-only, read-only push diagnostics. Values and endpoints never leave the
// server; the Settings UI receives only booleans and the owner's subscription count.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const publicVapid = !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateVapid = !!process.env.VAPID_PRIVATE_KEY
  const sendSecret = process.env.PUSH_SEND_SECRET || ''

  const { count: subscriptionCount, error: subscriptionError } = await supabase
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if (subscriptionError) logSafeServerError('push.status.subscription_count', subscriptionError)

  const admin = createAdminClient()
  let endpointConfigured = false
  let endpointValid = false
  let dispatchSecretConfigured = false
  let dispatchSecretMatches = false
  let dispatchReadable = false

  if (admin) {
    const { data, error } = await admin.from('push_config')
      .select('endpoint_url, secret')
      .eq('id', 1)
      .maybeSingle()
    if (error) {
      logSafeServerError('push.status.dispatch_config', error)
    } else {
      dispatchReadable = true
      const config = data as { endpoint_url?: string | null; secret?: string | null } | null
      const endpoint = config?.endpoint_url?.trim() || ''
      endpointConfigured = !!endpoint
      try {
        const parsed = new URL(endpoint)
        endpointValid = parsed.protocol === 'https:' && parsed.pathname === '/api/push/send'
      } catch { endpointValid = false }
      dispatchSecretConfigured = !!config?.secret
      dispatchSecretMatches = !!sendSecret && config?.secret === sendSecret
    }
  }

  const ready = publicVapid && privateVapid && !!sendSecret
    && endpointValid && dispatchSecretConfigured && dispatchSecretMatches

  return NextResponse.json({
    ready,
    config: {
      publicVapid,
      privateVapid,
      sendSecret: !!sendSecret,
      endpointConfigured,
      endpointValid,
      dispatchSecretConfigured,
      dispatchSecretMatches,
      dispatchReadable,
    },
    subscriptionCount: subscriptionError ? null : (subscriptionCount ?? 0),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
