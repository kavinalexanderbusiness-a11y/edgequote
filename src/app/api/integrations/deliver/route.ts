// POST /api/integrations/deliver — the delivery worker's front door.
//
// Called three ways:
//   1. The DB nudge trigger (pg_net) the moment deliveries are fanned out —
//      authed by x-integrations-secret matching INTEGRATIONS_DELIVER_SECRET
//      (the same value stored in integrations_config; see the RUN file).
//   2. Ops/cron tooling with the CRON_SECRET bearer.
//   3. A signed-in owner (test sends, retry-now) — processes THEIR rows only.
// Fails closed: no secret configured + no session = 403. The cron sweep is
// the guarantee either way; this route is the low-latency path.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processDueDeliveries } from '@/lib/integrations/deliver'
import { safeEqual } from '@/lib/integrations/signing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function providedSecret(req: NextRequest): string {
  const header = req.headers.get('x-integrations-secret')
  if (header) return header.trim()
  const authz = req.headers.get('authorization') ?? ''
  return authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
}

function secretOk(req: NextRequest): boolean {
  const provided = providedSecret(req)
  if (!provided) return false
  const accepted = [process.env.INTEGRATIONS_DELIVER_SECRET, process.env.CRON_SECRET]
    .filter((s): s is string => Boolean(s))
  return accepted.some((s) => safeEqual(provided, s))
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient()
  if (!admin) {
    console.error('[integrations/deliver] SUPABASE_SERVICE_ROLE_KEY missing — cannot deliver')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  let userScope: string | null = null
  if (!secretOk(req)) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    userScope = user.id
  }

  try {
    const summary = await processDueDeliveries(admin, userScope, 40_000)
    // Deliberately unconditional — a quiet run is still evidence the worker ran.
    console.log('[integrations/deliver] run:', JSON.stringify({ scope: userScope ? 'user' : 'all', ...summary }))
    return NextResponse.json({ ok: true, ...summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[integrations/deliver] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
