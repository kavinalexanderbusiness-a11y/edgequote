import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// Remove this browser's subscription when the owner turns push off. RLS-scoped to
// the signed-in user; a missing endpoint just clears all of their rows (used when
// the browser already dropped the subscription and we only want to clean up).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { endpoint?: string } | null
  let q = supabase.from('push_subscriptions').delete().eq('user_id', user.id)
  if (body?.endpoint) q = q.eq('endpoint', body.endpoint)
  const { error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
