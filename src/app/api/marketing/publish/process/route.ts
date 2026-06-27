import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processDueJobs } from '@/lib/marketing/publishQueue'

export const dynamic = 'force-dynamic'

// POST /api/marketing/publish/process — on-demand queue processing for the SIGNED-IN
// owner. This is what makes scheduled posts work WITHOUT a paid Vercel plan: the Studio
// (and publish actions) call it, and any of this owner's due jobs are driven forward via
// their own RLS session — no cron, no service-role key, no secret. Safe to call on every
// load: it's bounded and idempotent, so it never double-posts. The daily cron is just an
// optional backstop on top of this.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })
  const result = await processDueJobs(supabase) // RLS auto-scopes to this owner
  return NextResponse.json({ ok: true, ...result })
}
