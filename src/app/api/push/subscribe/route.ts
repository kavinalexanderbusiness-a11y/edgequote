import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// Save (or refresh) the push subscription for the signed-in owner's current
// browser. Called by the "Enable notifications" flow AFTER the user granted
// permission and the service worker minted a PushSubscription. RLS-scoped: the
// session client can only write the user's own row, and (user_id, endpoint) is
// unique so re-enabling on the same device updates in place instead of duplicating.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null
  const endpoint = body?.endpoint
  const p256dh = body?.keys?.p256dh
  const auth = body?.keys?.auth
  if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: 'bad subscription' }, { status: 400 })

  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint,
    p256dh,
    auth,
    user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'user_id,endpoint' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
